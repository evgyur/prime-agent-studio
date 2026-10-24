//! Studio loopback port: preferred resolution with persistent fallback.
//!
//! The preferred port comes from the `PRIME_STUDIO_DESKTOP_PORT` environment
//! override (strict, no fallback) or from the `port` field of
//! `desktop.json` (default 3088). When the preferred port cannot be bound
//! (Windows reserved ranges surface as EACCES / permission denied) or is
//! already taken by another application, the resolver walks spaced
//! alternatives, then an OS ephemeral port. A healthy Studio already serving
//! the preferred port is reused instead of being treated as a conflict, and
//! a verified live server we own on another port is reused so two writers
//! never share one data root.
//!
//! The fallback is persistent: when the effective port moves away from the
//! preference (and no env override is set), the effective port is written
//! back to `desktop.json` at startup. The next launch therefore serves the
//! same origin instead of flip-flopping, while `Desktop` keeps the original
//! preference for this launch's `movedFrom` notice.
//!
//! Ownership is verified by instance identity, never by port alone: the
//! backend hint (last effective port from `backend.json`) is only trusted
//! when its live `/api/health` instanceId matches the ownership record in
//! `<root>/data/server.json` written by `startServer`.
//!
//! The effective port is resolved in `setup`, before the exact-origin
//! capability (`http://127.0.0.1:{port}/*`) is registered, so the WebView
//! origin always matches the server that will actually serve it.

use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::time::{Duration, Instant};

/// Default Studio loopback port (clean 4.4.4 baseline).
pub(crate) const DEFAULT_STUDIO_PORT: u16 = 3088;
/// Health service marker shared with `scripts/launcher-common.mjs`.
pub(crate) const SERVICE_NAME: &str = "prime-agent-gui";
/// Spaced offsets keep fallback candidates away from neighbouring services.
pub(crate) const FALLBACK_OFFSETS: [u16; 4] = [101, 211, 331, 557];
/// Per-read socket timeout inside the health probe.
const PROBE_TIMEOUT: Duration = Duration::from_millis(700);
/// Total deadline for one health probe, so deliberately split responses
/// still assemble while a hanging socket can never stall startup.
const PROBE_TOTAL_TIMEOUT: Duration = Duration::from_millis(2500);
/// Largest health response we will buffer (health bodies are ~200 bytes).
const READ_BUDGET: usize = 32 * 1024;

/// Minimal health state of one loopback port.
pub(crate) enum PortProbe {
    /// Our Studio service answered `/api/health` with status ok. The payload
    /// carries the health body (pid, instanceId) for ownership matching.
    #[allow(dead_code)]
    Ready(serde_json::Value),
    /// Something else answers, or the port times out mid-handshake.
    Occupied,
    /// Connection refused: nothing listens.
    Absent,
}

impl PortProbe {
    pub(crate) fn is_ready(&self) -> bool {
        matches!(self, PortProbe::Ready(_))
    }
    pub(crate) fn is_absent(&self) -> bool {
        matches!(self, PortProbe::Absent)
    }
}

/// Failed handshakes carry no occupant: refused, timed-out and would-block
/// connects report Absent. Every other connect failure stays Occupied; the
/// bind check remains the authority on whether the port is actually free.
pub(crate) fn connect_failure_is_absent(kind: io::ErrorKind) -> bool {
    matches!(
        kind,
        io::ErrorKind::ConnectionRefused
            | io::ErrorKind::TimedOut
            | io::ErrorKind::WouldBlock
    )
}

/// Parse an explicit port value (env var or IPC argument).
/// Stable error: `port_invalid` for any non-integer or out-of-range input.
pub(crate) fn parse_port_value(raw: Option<&str>) -> Result<Option<u16>, String> {
    match raw {
        None => Ok(None),
        Some(text) if text.trim().is_empty() => Ok(None),
        Some(text) => {
            let value: i64 = text.trim().parse().map_err(|_| "port_invalid".to_string())?;
            if !(1..=65535).contains(&value) {
                return Err("port_invalid".into());
            }
            Ok(Some(value as u16))
        }
    }
}

/// Strict environment override. `Some` means "use exactly this port".
pub(crate) fn env_port_override() -> Result<Option<u16>, String> {
    parse_port_value(std::env::var("PRIME_STUDIO_DESKTOP_PORT").ok().as_deref())
}

/// Preferred port from persisted preferences. Zero is never valid and falls
/// back to the default so hand-edited files cannot wedge the launcher.
pub(crate) fn preferred_port(persisted: Option<u16>) -> u16 {
    persisted.filter(|port| *port != 0).unwrap_or(DEFAULT_STUDIO_PORT)
}

/// Ordered candidates: preferred first, then spaced alternatives.
pub(crate) fn fallback_candidates(preferred: u16) -> Vec<u16> {
    let mut out = vec![preferred];
    for offset in FALLBACK_OFFSETS {
        if let Some(port) = preferred.checked_add(offset) {
            if port != 0 && !out.contains(&port) {
                out.push(port);
            }
        }
    }
    out
}

/// Blocking `/api/health` probe. Mirrors `probeHealth` in
/// `scripts/launcher-common.mjs`: only a 200 JSON body with our service
/// name and `status: ok` counts as ready; a completed connection that says
/// anything else (or stalls) is a foreign occupant that must never be
/// reused.
///
/// A *failed* connection is not an occupant: refused, timed-out or
/// otherwise unestablished handshakes report Absent (Windows loopback has
/// been observed to time out connects on free ports while binds succeed).
/// Callers always pair Absent with a bind check, so a real listener can
/// never be mistaken for a free port.
///
/// The full body is read under a total deadline, honouring Content-Length
/// when present and connection close (HTTP/1.0) otherwise, so responses
/// split across several TCP segments still assemble. Offsets from the raw
/// byte buffer are never applied to the lossy-decoded string.
pub(crate) fn probe_port_state(port: u16) -> PortProbe {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = match TcpStream::connect_timeout(&addr, PROBE_TIMEOUT) {
        Ok(stream) => stream,
        // No handshake, no occupant. Bind state (checked by every caller)
        // is the authority on whether the port is actually free.
        Err(error) if connect_failure_is_absent(error.kind()) => {
            return PortProbe::Absent;
        }
        Err(_) => return PortProbe::Occupied,
    };
    let _ = stream.set_read_timeout(Some(PROBE_TIMEOUT));
    let _ = stream.set_write_timeout(Some(PROBE_TIMEOUT));
    let request = format!(
        "GET /api/health HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return PortProbe::Occupied;
    }
    let mut raw = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    let deadline = Instant::now() + PROBE_TOTAL_TIMEOUT;
    let mut header_end: Option<usize> = None;
    let mut content_length: Option<usize> = None;
    loop {
        if Instant::now() >= deadline {
            break;
        }
        match stream.read(&mut chunk) {
            // EOF: HTTP/1.0 close, whatever arrived is the full body.
            Ok(0) => break,
            Ok(size) => {
                raw.extend_from_slice(&chunk[..size]);
                if raw.len() > READ_BUDGET {
                    break;
                }
                if header_end.is_none() {
                    if let Some(end) = find_header_end(&raw) {
                        content_length = parse_content_length(&raw[..end]);
                        header_end = Some(end);
                    }
                }
                // With a known length, stop as soon as the body is whole;
                // without one, keep reading until close or the deadline.
                if let Some(end) = header_end {
                    if let Some(len) = content_length {
                        if raw.len() >= end.saturating_add(len) {
                            break;
                        }
                    }
                }
            }
            // No more data within the per-read timeout: evaluate what we
            // have instead of failing a slow-but-valid response.
            Err(error)
                if error.kind() == io::ErrorKind::TimedOut
                    || error.kind() == io::ErrorKind::WouldBlock =>
            {
                break
            }
            Err(_) => return PortProbe::Occupied,
        }
    }
    let end = match header_end {
        Some(end) => end,
        None => return PortProbe::Occupied,
    };
    if !header_status_ok(&raw[..end]) {
        return PortProbe::Occupied;
    }
    // Byte-slicing the raw buffer is always safe; decoding happens after.
    let body = String::from_utf8_lossy(&raw[end..]);
    let health: serde_json::Value = match serde_json::from_str(body.trim()) {
        Ok(value) => value,
        Err(_) => return PortProbe::Occupied,
    };
    let ours = health.get("service").and_then(|s| s.as_str()) == Some(SERVICE_NAME)
        && health.get("status").and_then(|s| s.as_str()) == Some("ok");
    if ours {
        PortProbe::Ready(health)
    } else {
        PortProbe::Occupied
    }
}

fn find_header_end(raw: &[u8]) -> Option<usize> {
    raw.windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
}

/// The status line sits at the head of the raw header block, so byte
/// matching avoids any decoded-string offset arithmetic.
fn header_status_ok(header_block: &[u8]) -> bool {
    let first_line_end = header_block
        .iter()
        .position(|byte| *byte == b'\n')
        .unwrap_or(header_block.len());
    header_block[..first_line_end]
        .windows(5)
        .any(|window| window == b" 200 ")
}

fn parse_content_length(header_block: &[u8]) -> Option<usize> {
    let text = String::from_utf8_lossy(header_block);
    text.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if name.trim().eq_ignore_ascii_case("content-length") {
            value.trim().parse::<usize>().ok()
        } else {
            None
        }
    })
}

/// A port is bindable when nothing (foreign service or reserved exclusion)
/// holds it. Windows reserved ranges fail here with a permission error
/// (EACCES); that is an ordinary "try the next candidate" signal.
pub(crate) fn port_bind_available(port: u16) -> bool {
    TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).is_ok()
}

/// Destination check for an explicit port change. Bind-first: a
/// successful loopback bind proves nobody listens, so no connect wait is
/// needed (free ports whose connects time out are usable, not rejected).
/// A held port rejects with `port_unavailable` whatever any probe says.
pub(crate) fn destination_available_live(port: u16) -> bool {
    port_bind_available(port)
}

/// Claim one OS ephemeral port and release it. The caller (desktop-start,
/// under its launcher lock) binds it for real moments later; a lost race
/// surfaces there as `occupied`, never as a duplicate server.
pub(crate) fn ephemeral_port() -> Option<u16> {
    TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .ok()
        .and_then(|listener| listener.local_addr().ok().map(|addr| addr.port()))
        .filter(|port| *port != 0)
}

/// Last effective port persisted by a previous start/restart, if any.
pub(crate) fn read_backend_port(root: &Path) -> Option<u16> {
    let bytes = std::fs::read(root.join("backend.json")).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    value.get("port")?.as_u64().and_then(|port| {
        if (1..=65535).contains(&port) {
            Some(port as u16)
        } else {
            None
        }
    })
}

/// Node-side ownership record for this data root (`<root>/data/server.json`,
/// written by `startServer` as `{pid, instanceId, port, startedAt}`).
pub(crate) struct ServerIdentity {
    pub(crate) port: u16,
    pub(crate) instance_id: String,
}

pub(crate) fn read_server_identity(root: &Path) -> Option<ServerIdentity> {
    let bytes = std::fs::read(root.join("data").join("server.json")).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let port = value.get("port")?.as_u64()?;
    let instance_id = value.get("instanceId")?.as_str()?;
    if !(1..=65535).contains(&port) || instance_id.is_empty() {
        return None;
    }
    Some(ServerIdentity {
        port: port as u16,
        instance_id: instance_id.to_string(),
    })
}

/// Verified live server owned by this data root on another port, if any.
/// The backend hint (last effective port) is only trusted when its live
/// `/api/health` instanceId matches our ownership record; a bare Ready
/// (any healthy Studio) is never enough to claim a port as ours.
/// Bind-first: a port that binds is definitely not listening, so it is
/// skipped with no connect wait; only a held port is probed for identity.
pub(crate) fn owned_live_port(
    root: &Path,
    backend_hint: Option<u16>,
    probe: &dyn Fn(u16) -> PortProbe,
) -> Option<u16> {
    let identity = read_server_identity(root)?;
    let mut ports = vec![identity.port];
    if let Some(hint) = backend_hint {
        if hint != identity.port {
            ports.push(hint);
        }
    }
    for port in ports {
        if port == 0 || port_bind_available(port) {
            continue;
        }
        if let PortProbe::Ready(health) = probe(port) {
            let live = health
                .get("instanceId")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            if !live.is_empty() && live == identity.instance_id {
                return Some(port);
            }
        }
    }
    None
}

/// Pure selection core: preferred, then spaced alternatives, then the
/// ephemeral fallback. `moved_from` is `Some(preferred)` whenever the
/// effective port differs from the preference. Service reuse (preferred
/// Ready, verified owned-live) keeps probe precedence; everything else is
/// bind-first: a successful bind proves the port free with no connect wait
/// (free ports whose connects time out are usable, not rejected), while a
/// held port is skipped whatever any probe says. A healthy but unverified
/// Studio is never stolen. EACCES-style bind failures behave exactly like
/// held ports: skip, never abort.
pub(crate) fn select_effective_port_with(
    preferred: u16,
    owned_live: Option<u16>,
    probe: &dyn Fn(u16) -> PortProbe,
    bind_available: &dyn Fn(u16) -> bool,
    ephemeral: &dyn Fn() -> Option<u16>,
) -> (u16, Option<u16>) {
    let moved_from = |effective: u16| {
        if effective == preferred {
            None
        } else {
            Some(preferred)
        }
    };
    // A healthy Studio on the preferred port is reused, not treated as a
    // conflict. The preferred port is probed exactly once here.
    let first = probe(preferred);
    if first.is_ready() {
        return (preferred, None);
    }
    // Reuse our own verified live server on another port instead of
    // starting a second writer on the same data root.
    if let Some(other) = owned_live {
        if other != preferred && other != 0 && probe(other).is_ready() {
            return (other, moved_from(other));
        }
    }
    if first.is_absent() && bind_available(preferred) {
        return (preferred, None);
    }
    for candidate in fallback_candidates(preferred).into_iter().skip(1) {
        // Already probed above when it carries our stale ownership record.
        if Some(candidate) == owned_live {
            continue;
        }
        if bind_available(candidate) {
            return (candidate, moved_from(candidate));
        }
    }
    match ephemeral() {
        Some(port) => (port, moved_from(port)),
        None => (preferred, moved_from(preferred)),
    }
}

/// Live resolver used at startup: real probes, real binds, OS ephemeral.
/// Ownership is verified by instance identity before any cross-port reuse.
pub(crate) fn resolve_effective_port(root: &Path, preferred: u16) -> (u16, Option<u16>) {
    let owned = owned_live_port(root, read_backend_port(root), &probe_port_state);
    select_effective_port_with(
        preferred,
        owned,
        &probe_port_state,
        &port_bind_available,
        &ephemeral_port,
    )
}

/// Sticky-fallback rule: with no env override, an effective port that moved
/// away from the preference must be persisted so the next launch serves the
/// same origin instead of flip-flopping. Returns the value to store, or
/// `None` when nothing needs writing.
pub(crate) fn persisted_effective_port(
    preferred: u16,
    effective: u16,
    env_override: bool,
) -> Option<u16> {
    if env_override || effective == preferred {
        None
    } else {
        Some(effective)
    }
}

/// Guard rule for the restart exit window: the shared `starting` flag
/// stays held when a restart was requested, so a late Start IPC sees busy
/// instead of starting the old-port server while the new process boots.
/// No-op, refusal and error outcomes release it.
pub(crate) fn port_set_keep_starting_guard(
    result: &Result<(serde_json::Value, bool), String>,
) -> bool {
    matches!(result, Ok((_, true)))
}

/// Terminal tracking for a port-change outcome. Changed and no-op results
/// finish `done`; refusals (`reason`) and hard errors finish `error` with
/// the stable code, so the 1s light poll never shows a stuck operation.
pub(crate) fn port_change_terminal(
    result: &Result<(serde_json::Value, bool), String>,
) -> (&'static str, Option<String>) {
    match result {
        Ok((value, _)) => match value.get("reason").and_then(|reason| reason.as_str()) {
            Some(reason) => ("error", Some(reason.to_string())),
            None => ("done", None),
        },
        Err(error) => ("error", Some(error.clone())),
    }
}

/// Validation for an explicit port change that needs no I/O: env override
/// blocks the change, out-of-range values are `port_invalid`, and asking
/// for the port we already serve is a no-op. Availability (`port_unavailable`)
/// is checked afterwards against the live loopback state.
pub(crate) fn validate_port_request(
    env_override: bool,
    current: u16,
    requested: i64,
) -> Result<bool, String> {
    if env_override {
        return Err("port_env_override".into());
    }
    if !(1..=65535).contains(&requested) {
        return Err("port_invalid".into());
    }
    Ok(requested as u16 == current)
}

/// Outcome of stopping the old server before a port change.
pub(crate) enum StopOutcome {
    /// `stopped:true` or `already-stopped`: safe to persist and restart.
    Proceed,
    /// Active agents refused the stop; surface `reason: agents_running`.
    AgentsRunning(serde_json::Value),
    /// Any other failure (notably `server_not_managed`): refuse the change
    /// rather than risk a duplicate server.
    Failed(String),
}

pub(crate) fn classify_stop_result(result: &Result<serde_json::Value, String>) -> StopOutcome {
    match result {
        Ok(value) => {
            if value.get("stopped").and_then(|s| s.as_bool()).unwrap_or(false) {
                return StopOutcome::Proceed;
            }
            match value.get("reason").and_then(|r| r.as_str()) {
                Some("already-stopped") => StopOutcome::Proceed,
                Some("agents_running") => StopOutcome::AgentsRunning(value.clone()),
                Some(reason) => StopOutcome::Failed(reason.to_string()),
                None => StopOutcome::Failed("server_stop_failed".into()),
            }
        }
        Err(error) => {
            if error.contains("agents_running") {
                StopOutcome::AgentsRunning(serde_json::json!({"reason": "agents_running"}))
            } else {
                StopOutcome::Failed(error.clone())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as IoWrite;
    use std::net::TcpListener as Listener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn always_bind(_: u16) -> bool {
        true
    }
    fn no_ephemeral() -> Option<u16> {
        None
    }

    #[test]
    fn env_values_accept_only_1_to_65535() {
        assert_eq!(parse_port_value(None).unwrap(), None);
        assert_eq!(parse_port_value(Some("")).unwrap(), None);
        assert_eq!(parse_port_value(Some("3088")).unwrap(), Some(3088));
        assert_eq!(parse_port_value(Some(" 3099 ")).unwrap(), Some(3099));
        for raw in ["0", "-1", "65536", "99999", "abc", "30.88", "3088x"] {
            assert_eq!(parse_port_value(Some(raw)), Err("port_invalid".into()), "{raw}");
        }
    }

    #[test]
    fn preferred_defaults_to_3088_and_rejects_zero() {
        assert_eq!(preferred_port(None), 3088);
        assert_eq!(preferred_port(Some(0)), 3088);
        assert_eq!(preferred_port(Some(3099)), 3099);
    }

    #[test]
    fn candidates_are_preferred_then_spaced() {
        assert_eq!(fallback_candidates(3088), vec![3088, 3189, 3299, 3419, 3645]);
    }

    #[test]
    fn candidates_skip_overflow_without_wrapping() {
        let candidates = fallback_candidates(65500);
        assert_eq!(candidates, vec![65500]);
    }

    #[test]
    fn preferred_is_probed_exactly_once() {
        // Regression guard for the old double-probe: the preferred port may
        // be probed once even though selection also bind-checks it.
        let calls = Arc::new(AtomicUsize::new(0));
        let probe = {
            let calls = calls.clone();
            move |_: u16| {
                calls.fetch_add(1, Ordering::SeqCst);
                PortProbe::Absent
            }
        };
        let (port, moved_from) =
            select_effective_port_with(3088, None, &probe, &always_bind, &no_ephemeral);
        assert_eq!((port, moved_from), (3088, None));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn healthy_preferred_port_is_reused() {
        let probe = |port: u16| {
            if port == 3088 {
                PortProbe::Ready(serde_json::json!({"service": SERVICE_NAME, "status": "ok"}))
            } else {
                PortProbe::Absent
            }
        };
        let (port, moved_from) =
            select_effective_port_with(3088, None, &probe, &always_bind, &no_ephemeral);
        assert_eq!((port, moved_from), (3088, None));
    }

    #[test]
    fn eacces_style_bind_failure_falls_through_to_spaced_alternative() {
        // Simulates Windows reserved 3088: the bind fails with a permission
        // error (EACCES) exactly like an occupied port. Selection must skip
        // it and settle on the first spaced alternative, reporting the move.
        let probe = |_: u16| PortProbe::Absent;
        let bind_available = |port: u16| port != 3088;
        let (port, moved_from) =
            select_effective_port_with(3088, None, &probe, &bind_available, &no_ephemeral);
        assert_eq!((port, moved_from), (3189, Some(3088)));
    }

    #[test]
    fn foreign_occupant_on_preferred_is_skipped() {
        let probe = |port: u16| {
            if port == 3088 {
                PortProbe::Occupied
            } else {
                PortProbe::Absent
            }
        };
        let (port, moved_from) =
            select_effective_port_with(3088, None, &probe, &always_bind, &no_ephemeral);
        assert_eq!((port, moved_from), (3189, Some(3088)));
    }

    #[test]
    fn connect_failure_is_absent_but_never_free_without_bind() {
        // Failed handshakes (refused, timed out, would-block) carry no
        // occupant: Absent. Anything else after connect fails stays
        // Occupied; the bind check remains the authority on free.
        for kind in [
            io::ErrorKind::ConnectionRefused,
            io::ErrorKind::TimedOut,
            io::ErrorKind::WouldBlock,
        ] {
            assert!(connect_failure_is_absent(kind), "{kind:?}");
        }
        for kind in [
            io::ErrorKind::ConnectionReset,
            io::ErrorKind::ConnectionAborted,
            io::ErrorKind::PermissionDenied,
            io::ErrorKind::HostUnreachable,
            io::ErrorKind::AddrInUse,
        ] {
            assert!(!connect_failure_is_absent(kind), "{kind:?}");
        }
    }

    #[test]
    fn bind_held_candidates_skipped_without_probe_waits() {
        // Both 3088 and 3189 are held (bind fails): they are skipped via
        // the bind fast path with no connect wait, and 3299 is taken.
        // A healthy-but-unverified Studio on a held port is never stolen.
        let calls = Arc::new(AtomicUsize::new(0));
        let probe = {
            let calls = calls.clone();
            move |port: u16| {
                calls.fetch_add(1, Ordering::SeqCst);
                if port == 3088 {
                    PortProbe::Occupied
                } else {
                    PortProbe::Absent
                }
            }
        };
        let bind_available = |port: u16| port != 3088 && port != 3189;
        let (port, moved_from) =
            select_effective_port_with(3088, None, &probe, &bind_available, &no_ephemeral);
        assert_eq!((port, moved_from), (3299, Some(3088)));
        // Only the preferred port is probed at all.
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn free_fallback_taken_without_candidate_probes() {
        // EACCES-style bind failure on 3088, everything else bindable:
        // the first spaced alternative is taken with no per-candidate
        // connect wait (matters when free-port connects time out).
        let calls = Arc::new(AtomicUsize::new(0));
        let probe = {
            let calls = calls.clone();
            move |_: u16| {
                calls.fetch_add(1, Ordering::SeqCst);
                PortProbe::Absent
            }
        };
        let bind_available = |port: u16| port != 3088;
        let (port, moved_from) =
            select_effective_port_with(3088, None, &probe, &bind_available, &no_ephemeral);
        assert_eq!((port, moved_from), (3189, Some(3088)));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn verified_owned_server_on_other_port_is_reused() {
        // Preferred is free but our verified server still answers on 3189:
        // reuse it instead of starting a second writer on the same data root.
        let probe = |port: u16| {
            if port == 3189 {
                PortProbe::Ready(serde_json::json!({"service": SERVICE_NAME, "status": "ok"}))
            } else {
                PortProbe::Absent
            }
        };
        let (port, moved_from) =
            select_effective_port_with(3088, Some(3189), &probe, &always_bind, &no_ephemeral);
        assert_eq!((port, moved_from), (3189, Some(3088)));
    }

    #[test]
    fn stale_owned_record_does_not_block_fallback() {
        // server.json points at 3189 but nothing answers there anymore: the
        // stale record is skipped, not re-probed, and fallback proceeds.
        let calls = Arc::new(AtomicUsize::new(0));
        let probe = {
            let calls = calls.clone();
            move |port: u16| {
                calls.fetch_add(1, Ordering::SeqCst);
                if port == 3088 {
                    PortProbe::Occupied
                } else {
                    PortProbe::Absent
                }
            }
        };
        let (port, moved_from) =
            select_effective_port_with(3088, Some(3189), &probe, &always_bind, &no_ephemeral);
        assert_eq!((port, moved_from), (3299, Some(3088)));
        // Preferred and stale 3189 only; held-free candidates need no probe.
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn exhausted_candidates_fall_back_to_ephemeral() {
        // Every candidate is truly held (bind fails everywhere): no probe
        // verdict can free them, so the OS ephemeral port is used.
        let probe = |_: u16| PortProbe::Occupied;
        let never_bind = |_: u16| false;
        let ephemeral = || Some(51234);
        let (port, moved_from) = select_effective_port_with(3088, None, &probe, &never_bind, &ephemeral);
        assert_eq!((port, moved_from), (51234, Some(3088)));
    }

    #[test]
    fn total_exhaustion_keeps_preferred_without_move_marker() {
        // Every candidate is held and no ephemeral port exists: the only
        // honest answer is the preferred port itself (desktop-start will
        // surface the real conflict). Effective equals preferred, so there
        // is no move to report.
        let probe = |_: u16| PortProbe::Occupied;
        let never_bind = |_: u16| false;
        let (port, moved_from) = select_effective_port_with(3088, None, &probe, &never_bind, &no_ephemeral);
        assert_eq!((port, moved_from), (3088, None));
    }

    #[test]
    fn loopback_bind_decides_destination_availability() {
        // A held listener rejects the destination; a released port accepts
        // it with no connect wait (the production repro: free-port connects
        // may time out, but the bind proves the port free).
        let held = Listener::bind("127.0.0.1:0").unwrap();
        let busy = held.local_addr().unwrap().port();
        assert!(!port_bind_available(busy));
        assert!(!destination_available_live(busy));
        let free = free_loopback_port();
        assert!(destination_available_live(free));
    }

    #[test]
    fn real_resolver_keeps_freshly_released_preferred() {
        // Production repro regression: resolve twice against a freshly
        // released loopback port with an empty root. The exact preferred
        // port must win both times (no ephemeral flip-flop), and it must
        // be reported available for an explicit change.
        let dir = std::env::temp_dir().join(format!("studio-port-real-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let preferred = free_loopback_port();
        let first = resolve_effective_port(&dir, preferred);
        let second = resolve_effective_port(&dir, preferred);
        assert_eq!(first, (preferred, None));
        assert_eq!(second, (preferred, None));
        assert!(destination_available_live(preferred));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn real_resolver_falls_back_from_held_preferred() {
        // Preferred held by a silent listener (connect stalls like a
        // foreign service): the resolver must move to the first spaced
        // alternative and stay there across calls.
        let dir = std::env::temp_dir().join(format!("studio-port-held-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let held = Listener::bind("127.0.0.1:0").unwrap();
        let preferred = held.local_addr().unwrap().port();
        let (first, moved_first) = resolve_effective_port(&dir, preferred);
        assert_ne!(first, preferred);
        assert_eq!(moved_first, Some(preferred));
        assert!(destination_available_live(first));
        assert!(!destination_available_live(preferred));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn request_validation_blocks_env_override_and_bad_ports() {
        assert_eq!(
            validate_port_request(true, 3088, 3099),
            Err("port_env_override".into())
        );
        for bad in [0, -5, 65536, 100000] {
            assert_eq!(
                validate_port_request(false, 3088, bad),
                Err("port_invalid".into()),
                "{bad}"
            );
        }
        assert_eq!(validate_port_request(false, 3088, 3088), Ok(true));
        assert_eq!(validate_port_request(false, 3189, 3088), Ok(false));
    }

    #[test]
    fn stop_refusal_semantics_protect_active_agents() {
        // agents_running (value or thrown string) is a refusal, never a
        // silent proceed; anything unmanaged fails closed.
        let refusal = Ok(serde_json::json!({"stopped": false, "reason": "agents_running", "activeRuns": 2}));
        assert!(matches!(
            classify_stop_result(&refusal),
            StopOutcome::AgentsRunning(_)
        ));
        let thrown: Result<serde_json::Value, String> = Err("agents_running".into());
        assert!(matches!(
            classify_stop_result(&thrown),
            StopOutcome::AgentsRunning(_)
        ));
        assert!(matches!(
            classify_stop_result(&Ok(serde_json::json!({"stopped": true}))),
            StopOutcome::Proceed
        ));
        assert!(matches!(
            classify_stop_result(&Ok(serde_json::json!({"stopped": false, "reason": "already-stopped"}))),
            StopOutcome::Proceed
        ));
        assert!(matches!(
            classify_stop_result(&Err("server_not_managed".into())),
            StopOutcome::Failed(_)
        ));
        assert!(matches!(
            classify_stop_result(&Ok(serde_json::json!({"stopped": false, "reason": "server_not_managed"}))),
            StopOutcome::Failed(_)
        ));
    }

    #[test]
    fn fallback_persist_rule_fires_only_on_real_moves() {
        // A move without env override persists the effective port; a
        // same-port result or a strict env override writes nothing.
        assert_eq!(persisted_effective_port(3088, 3189, false), Some(3189));
        assert_eq!(persisted_effective_port(3088, 3088, false), None);
        assert_eq!(persisted_effective_port(3088, 3189, true), None);
        assert_eq!(persisted_effective_port(3189, 3189, false), None);
    }

    #[test]
    fn sticky_fallback_stabilizes_the_next_launch() {
        // Launch 1: EACCES on 3088 moves to 3189 and persists it.
        let probe = |_: u16| PortProbe::Absent;
        let bind_available = |port: u16| port != 3088;
        let (effective, moved_from) =
            select_effective_port_with(3088, None, &probe, &bind_available, &no_ephemeral);
        assert_eq!((effective, moved_from), (3189, Some(3088)));
        let stored = persisted_effective_port(3088, effective, false);
        assert_eq!(stored, Some(3189));
        // Launch 2: the persisted value is now the preference; the healthy
        // server answers there, so no move is reported anymore.
        let stored_value = stored.unwrap();
        assert_eq!(preferred_port(Some(stored_value)), 3189);
        let relaunched = |port: u16| {
            if port == 3189 {
                PortProbe::Ready(serde_json::json!({"service": SERVICE_NAME, "status": "ok"}))
            } else {
                PortProbe::Absent
            }
        };
        let (second, second_move) =
            select_effective_port_with(3189, None, &relaunched, &always_bind, &no_ephemeral);
        assert_eq!((second, second_move), (3189, None));
    }

    #[test]
    fn persisted_preference_roundtrips_through_desktop_json() {
        // What launch 1 writes, launch 2 reads back as its preference.
        let dir = std::env::temp_dir().join(format!("studio-port-persist-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(
            dir.join("desktop.json"),
            serde_json::json!({"started": true, "port": 3189}).to_string(),
        )
        .unwrap();
        let bytes = std::fs::read(dir.join("desktop.json")).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let stored = value
            .get("port")
            .and_then(|port| port.as_u64())
            .and_then(|port| u16::try_from(port).ok());
        assert_eq!(preferred_port(stored), 3189);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn preferences_stay_backward_compatible_without_port() {
        // desktop.json files written by 4.4.4 carry no port field.
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Legacy {
            #[allow(dead_code)]
            started: bool,
            #[allow(dead_code)]
            legacy_root: Option<String>,
        }
        let legacy: Legacy = serde_json::from_str(r#"{"started":true}"#).unwrap();
        assert!(legacy.started);
        let persisted: Option<u16> = serde_json::from_str::<serde_json::Value>(r#"{"started":true}"#)
            .unwrap()
            .get("port")
            .and_then(|p| p.as_u64())
            .and_then(|p| u16::try_from(p).ok());
        assert_eq!(preferred_port(persisted), 3088);
        let modern: serde_json::Value = serde_json::from_str(r#"{"started":true,"port":3099}"#).unwrap();
        let port = modern.get("port").and_then(|p| p.as_u64()).and_then(|p| u16::try_from(p).ok());
        assert_eq!(preferred_port(port), 3099);
    }

    #[test]
    fn backend_port_read_rejects_garbage() {
        let dir = std::env::temp_dir().join(format!("studio-port-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        assert_eq!(read_backend_port(&dir), None);
        std::fs::write(dir.join("backend.json"), r#"{"port":3189,"pid":123}"#).unwrap();
        assert_eq!(read_backend_port(&dir), Some(3189));
        std::fs::write(dir.join("backend.json"), r#"{"port":0}"#).unwrap();
        assert_eq!(read_backend_port(&dir), None);
        std::fs::write(dir.join("backend.json"), "not json").unwrap();
        assert_eq!(read_backend_port(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ownership_requires_matching_instance_identity() {
        // server.json for this root claims instance "a" on the hint port.
        let dir = std::env::temp_dir().join(format!("studio-port-owned-{}", std::process::id()));
        let _ = std::fs::create_dir_all(dir.join("data"));
        let owned = serve_health_once(serde_json::json!({
            "service": SERVICE_NAME, "status": "ok", "pid": 4242, "instanceId": "instance-a",
        }));
        std::fs::write(
            dir.join("data").join("server.json"),
            serde_json::json!({"pid": 4242, "instanceId": "instance-a", "port": owned, "startedAt": "t"}).to_string(),
        )
        .unwrap();
        // Matching identity: the hint port is verified as ours.
        assert_eq!(owned_live_port(&dir, Some(owned), &probe_port_state), Some(owned));
        // Same port, unrelated Studio (different instance): not ours.
        let foreign = serve_health_once(serde_json::json!({
            "service": SERVICE_NAME, "status": "ok", "pid": 9999, "instanceId": "instance-elsewhere",
        }));
        std::fs::write(
            dir.join("data").join("server.json"),
            serde_json::json!({"pid": 4242, "instanceId": "instance-a", "port": foreign, "startedAt": "t"}).to_string(),
        )
        .unwrap();
        assert_eq!(owned_live_port(&dir, Some(foreign), &probe_port_state), None);
        // No ownership record at all: fail closed even with a Ready hint.
        let _ = std::fs::remove_file(dir.join("data").join("server.json"));
        assert_eq!(owned_live_port(&dir, Some(owned), &probe_port_state), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn probe_assembles_split_content_length_body() {
        // Headers, then the JSON body in two delayed chunks: the old
        // header-only reader called this Occupied; the fixed reader sees Ready.
        let body = serde_json::json!({
            "service": SERVICE_NAME, "status": "ok", "pid": 111, "instanceId": "split-1",
        })
        .to_string();
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let port = serve_raw_parts(&[
            head.as_bytes(),
            &body.as_bytes()[..body.len() / 2],
            &body.as_bytes()[body.len() / 2..],
        ]);
        match probe_port_state(port) {
            PortProbe::Ready(health) => {
                assert_eq!(
                    health.get("instanceId").and_then(|v| v.as_str()),
                    Some("split-1")
                );
            }
            other => panic!("expected Ready, got {}", probe_name(&other)),
        }
    }

    #[test]
    fn probe_assembles_close_delimited_body() {
        // No Content-Length (HTTP/1.0 close semantics): read until EOF.
        let body = serde_json::json!({
            "service": SERVICE_NAME, "status": "ok", "pid": 222, "instanceId": "split-2",
        })
        .to_string();
        let port = serve_raw_parts(&[
            b"HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n",
            body.as_bytes(),
        ]);
        match probe_port_state(port) {
            PortProbe::Ready(health) => {
                assert_eq!(
                    health.get("instanceId").and_then(|v| v.as_str()),
                    Some("split-2")
                );
            }
            other => panic!("expected Ready, got {}", probe_name(&other)),
        }
    }

    #[test]
    fn probe_rejects_split_foreign_service() {
        // Split delivery must not smuggle a foreign service past the check.
        let body = r#"{"service":"something-else","status":"ok"}"#;
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
            body.len()
        );
        let port = serve_raw_parts(&[head.as_bytes(), &body.as_bytes()[..10], &body.as_bytes()[10..]]);
        assert!(matches!(probe_port_state(port), PortProbe::Occupied));
    }

    fn probe_name(probe: &PortProbe) -> &'static str {
        match probe {
            PortProbe::Ready(_) => "ready",
            PortProbe::Occupied => "occupied",
            PortProbe::Absent => "absent",
        }
    }

    /// Serve one connection with the given byte parts, pausing briefly
    /// between parts to force split TCP segments, then close.
    fn serve_raw_parts(parts: &[&[u8]]) -> u16 {
        let owned: Vec<Vec<u8>> = parts.iter().map(|part| part.to_vec()).collect();
        let listener = Listener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut discard = [0u8; 512];
                let _ = std::io::Read::read(&mut stream, &mut discard);
                for part in &owned {
                    let _ = stream.write_all(part);
                    let _ = stream.flush();
                    std::thread::sleep(Duration::from_millis(60));
                }
            }
        });
        port
    }

    /// Serve one `/api/health` answer with the given JSON body, split in
    /// two parts with Content-Length set.
    fn serve_health_once(health: serde_json::Value) -> u16 {
        let body = health.to_string();
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        serve_raw_parts(&[head.as_bytes(), body.as_bytes()])
    }

    fn track_mock_handle() -> tauri::AppHandle<tauri::test::MockRuntime> {
        let context = tauri::test::mock_context(tauri::test::noop_assets());
        tauri::test::mock_builder()
            .manage(crate::updates::Updates::default())
            .build(context)
            .unwrap()
            .handle()
            .clone()
    }

    #[test]
    fn starting_guard_held_only_across_restart() {
        // Late Start IPCs during the request_restart exit window must see
        // busy: only a requested restart keeps the shared starting guard.
        assert!(port_set_keep_starting_guard(&Ok((
            serde_json::json!({"changed": true, "port": 3189}),
            true
        ))));
        assert!(!port_set_keep_starting_guard(&Ok((
            serde_json::json!({"changed": false, "port": 3088}),
            false
        ))));
        assert!(!port_set_keep_starting_guard(&Ok((
            serde_json::json!({"changed": false, "reason": "agents_running"}),
            false
        ))));
        assert!(!port_set_keep_starting_guard(&Err("port_save_failed".to_string())));
        assert!(!port_set_keep_starting_guard(&Err("server_not_managed".to_string())));
    }

    #[test]
    fn port_change_tracking_reaches_terminal_on_all_outcomes() {
        // Every desktop_port_set exit must land the tracked operation in a
        // terminal stage: changed/no-op finish done, refusals and errors
        // finish error with the stable code. A mid-stop progress callback
        // (as relayed from run_desktop_control_with_phases) must not break
        // the terminal landing.
        let outcomes: Vec<Result<(serde_json::Value, bool), String>> = vec![
            Ok((serde_json::json!({"changed": true, "port": 3189}), true)),
            Ok((serde_json::json!({"changed": false, "port": 3088}), false)),
            Ok((
                serde_json::json!({"changed": false, "reason": "agents_running", "port": 3088}),
                false,
            )),
            Err("port_unavailable".to_string()),
            Err("port_env_override".to_string()),
            Err("server_not_managed".to_string()),
            Err("port_save_failed".to_string()),
        ];
        let expected: Vec<(&str, Option<&str>)> = vec![
            ("done", None),
            ("done", None),
            ("error", Some("agents_running")),
            ("error", Some("port_unavailable")),
            ("error", Some("port_env_override")),
            ("error", Some("server_not_managed")),
            ("error", Some("port_save_failed")),
        ];
        for (outcome, (want_stage, want_code)) in outcomes.iter().zip(expected) {
            let handle = track_mock_handle();
            let id =
                crate::updates::track_operation_start(&handle, "quit", "working", false).unwrap();
            let _ = crate::updates::track_operation_progress(
                &handle, &id, "working", 0, None, "stopping", false,
            );
            let (stage, code) = port_change_terminal(outcome);
            let finished =
                crate::updates::track_operation_finish(&handle, &id, stage, code.as_deref());
            assert_eq!(finished["stage"], serde_json::json!(want_stage));
            assert_eq!(finished["terminal"], serde_json::json!(true));
            match want_code {
                Some(want) => assert_eq!(finished["code"], serde_json::json!(want)),
                None => assert!(finished.get("code").is_none() || finished["code"].is_null()),
            }
        }
    }

    fn free_loopback_port() -> u16 {
        Listener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }
}
