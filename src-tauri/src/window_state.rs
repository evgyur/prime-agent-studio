//! Main window bounds across restarts: position, size and maximized state.
//! Restored bounds are fitted to the connected screens: a window larger than
//! its screen's work area shrinks to fit inside it, and a window whose title
//! bar is no longer on any screen moves back, centered, to the primary screen.
//! Stored values are physical pixels: outer position and inner (client) size.

use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

pub const FILE: &str = "window-state.json";
const MAIN: &str = "main";
/// Title bar strip that must stay on a screen to keep the saved position.
const TITLE: i32 = 32;
/// Width of that strip that must be grabbable.
const GRAB: i32 = 120;
const MIN_SIDE: u32 = 200;
const MAX_SIDE: u32 = 32_000;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct Saved {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub maximized: bool,
}

#[derive(Default, Deserialize, Serialize)]
struct StateFile {
    version: u32,
    #[serde(default)]
    windows: BTreeMap<String, Saved>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Length of the intersection of [a, a + a_len) and [b, b + b_len) (negative if none).
fn overlap(a: i32, a_len: i32, b: i32, b_len: i32) -> i32 {
    (a + a_len).min(b + b_len) - a.max(b)
}

fn fit(rect: Rect, area: Rect, center: bool) -> Rect {
    let width = rect.width.min(area.width);
    let height = rect.height.min(area.height);
    if center {
        return Rect {
            x: area.x + (area.width - width) / 2,
            y: area.y + (area.height - height) / 2,
            width,
            height,
        };
    }
    if width == rect.width && height == rect.height {
        return rect;
    }
    // Shrunk to this screen: keep it entirely inside.
    Rect {
        x: rect.x.clamp(area.x, area.x + area.width - width),
        y: rect.y.clamp(area.y, area.y + area.height - height),
        width,
        height,
    }
}

/// Places a saved outer rect on the screens' work areas. Kept as it was while
/// its title bar is reachable on a screen (shrunk if larger than that screen);
/// otherwise centered on the primary screen, shrunk to fit.
pub fn place(saved: Rect, areas: &[Rect], primary: usize) -> Rect {
    if areas.is_empty() {
        return saved;
    }
    let grab = saved.width.min(GRAB);
    let covered = |a: &Rect| {
        i64::from(overlap(saved.x, saved.width, a.x, a.width).max(0))
            * i64::from(overlap(saved.y, saved.height, a.y, a.height).max(0))
    };
    let target = areas
        .iter()
        .filter(|a| {
            overlap(saved.x, saved.width, a.x, a.width) >= grab
                && overlap(saved.y, TITLE, a.y, a.height) > 0
        })
        .max_by_key(|a| covered(a));
    match target {
        Some(area) => fit(saved, *area, false),
        None => fit(saved, areas[primary.min(areas.len() - 1)], true),
    }
}

fn read(path: &Path) -> StateFile {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<StateFile>(&bytes).ok())
        .filter(|file| file.version == 1)
        .unwrap_or_default()
}

pub fn load(path: &Path) -> Option<Saved> {
    read(path).windows.get(MAIN).copied()
}

/// Writes the main window entry and keeps any other window entries.
pub fn save(path: &Path, saved: Saved) -> std::io::Result<()> {
    let mut file = read(path);
    file.version = 1;
    file.windows.insert(MAIN.into(), saved);
    let bytes = serde_json::to_vec_pretty(&file).map_err(std::io::Error::other)?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, bytes)?;
    fs::rename(temp, path)
}

fn sane(saved: &Saved) -> bool {
    (MIN_SIDE..=MAX_SIDE).contains(&saved.width) && (MIN_SIDE..=MAX_SIDE).contains(&saved.height)
}

/// Applies saved bounds to the hidden, freshly built main window, fitted to the
/// current screens. Returns the state to track. Maximizing is left to the
/// caller: on Windows it would also show the window.
pub fn restore(window: &WebviewWindow, saved: Saved) -> Saved {
    if !sane(&saved) {
        return saved;
    }
    let monitors = window.available_monitors().unwrap_or_default();
    let primary_position = window
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| *monitor.position());
    let primary = monitors
        .iter()
        .position(|monitor| Some(*monitor.position()) == primary_position)
        .unwrap_or(0);
    let areas: Vec<Rect> = monitors
        .iter()
        .map(|monitor| {
            let area = monitor.work_area();
            Rect {
                x: area.position.x,
                y: area.position.y,
                width: area.size.width as i32,
                height: area.size.height as i32,
            }
        })
        .collect();
    // Frame (borders and title bar) of this window, to reason on outer rects.
    let (frame_width, frame_height) = match (window.outer_size(), window.inner_size()) {
        (Ok(outer), Ok(inner)) => (
            outer.width.saturating_sub(inner.width) as i32,
            outer.height.saturating_sub(inner.height) as i32,
        ),
        _ => (0, 0),
    };
    let outer = Rect {
        x: saved.x,
        y: saved.y,
        width: saved.width as i32 + frame_width,
        height: saved.height as i32 + frame_height,
    };
    let placed = place(outer, &areas, primary);
    let width = (placed.width - frame_width).max(1) as u32;
    let height = (placed.height - frame_height).max(1) as u32;
    // Position first: moving to a screen with another scale resizes the window.
    let _ = window.set_position(PhysicalPosition::new(placed.x, placed.y));
    let _ = window.set_size(PhysicalSize::new(width, height));
    Saved {
        x: placed.x,
        y: placed.y,
        width,
        height,
        maximized: saved.maximized,
    }
}

pub struct Tracker {
    path: PathBuf,
    state: Mutex<Option<Saved>>,
    pending_maximize: AtomicBool,
    scheduled: AtomicBool,
}

impl Tracker {
    pub fn new(path: PathBuf, state: Option<Saved>, pending_maximize: bool) -> Self {
        Self {
            path,
            state: Mutex::new(state),
            pending_maximize: AtomicBool::new(pending_maximize),
            scheduled: AtomicBool::new(false),
        }
    }
}

/// A background start keeps the window hidden: it is maximized on first show.
pub fn take_pending_maximize(app: &tauri::AppHandle) -> bool {
    app.try_state::<Tracker>()
        .is_some_and(|tracker| tracker.pending_maximize.swap(false, Ordering::SeqCst))
}

/// Records the main window bounds after a move or resize; writes are debounced.
pub fn track(window: &tauri::Window) {
    // Hidden windows do not move, and Windows parks minimized ones at -32000.
    if !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(true) {
        return;
    }
    let Some(tracker) = window.try_state::<Tracker>() else {
        return;
    };
    let maximized = window.is_maximized().unwrap_or(false);
    {
        let Ok(mut guard) = tracker.state.lock() else {
            return;
        };
        let mut next = guard.unwrap_or_default();
        next.maximized = maximized;
        // Maximized: keep the last normal bounds, so restoring un-maximizes there.
        if !maximized {
            let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
                return;
            };
            next.x = position.x;
            next.y = position.y;
            next.width = size.width;
            next.height = size.height;
        }
        if *guard == Some(next) {
            return;
        }
        *guard = Some(next);
    }
    if tracker.scheduled.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = window.app_handle().clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        let Some(tracker) = app.try_state::<Tracker>() else {
            return;
        };
        tracker.scheduled.store(false, Ordering::SeqCst);
        let state = tracker.state.lock().ok().and_then(|guard| *guard);
        if let Some(state) = state {
            let _ = save(&tracker.path, state);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // Three 2560x1440 screens side by side, 48 px taskbar: like a real desk.
    const LEFT: Rect = Rect { x: -2560, y: 0, width: 2560, height: 1392 };
    const PRIMARY: Rect = Rect { x: 0, y: 0, width: 2560, height: 1392 };
    const RIGHT: Rect = Rect { x: 2560, y: 0, width: 2560, height: 1392 };
    const DESK: [Rect; 3] = [PRIMARY, LEFT, RIGHT];

    #[test]
    fn keeps_a_window_that_fits_its_screen_even_on_negative_coordinates() {
        let window = Rect { x: -2400, y: 100, width: 1600, height: 900 };
        assert_eq!(place(window, &DESK, 0), window);
    }

    #[test]
    fn keeps_a_window_past_an_edge_while_its_title_bar_is_reachable() {
        let window = Rect { x: 2000, y: 50, width: 1200, height: 800 };
        assert_eq!(place(window, &[PRIMARY], 0), window);
    }

    #[test]
    fn shrinks_a_window_larger_than_its_screen_and_keeps_it_inside() {
        let window = Rect { x: -100, y: -20, width: 3000, height: 1600 };
        assert_eq!(place(window, &[PRIMARY], 0), PRIMARY);
    }

    #[test]
    fn uses_the_screen_that_holds_most_of_the_window() {
        let window = Rect { x: -2600, y: 0, width: 2700, height: 800 };
        assert_eq!(
            place(window, &DESK, 0),
            Rect { x: -2560, y: 0, width: 2560, height: 800 }
        );
    }

    #[test]
    fn moves_a_window_left_on_a_disconnected_screen_to_the_primary_one() {
        let window = Rect { x: -2400, y: 100, width: 1600, height: 900 };
        assert_eq!(
            place(window, &[PRIMARY], 0),
            Rect { x: 480, y: 246, width: 1600, height: 900 }
        );
    }

    #[test]
    fn moves_a_window_whose_title_bar_is_above_every_screen() {
        let window = Rect { x: 200, y: -600, width: 1600, height: 900 };
        assert_eq!(
            place(window, &DESK, 0),
            Rect { x: 480, y: 246, width: 1600, height: 900 }
        );
    }

    #[test]
    fn fits_an_off_screen_window_larger_than_the_primary_screen() {
        let window = Rect { x: 9000, y: 9000, width: 4000, height: 3000 };
        assert_eq!(place(window, &DESK, 1), LEFT);
    }

    #[test]
    fn keeps_the_saved_bounds_without_screen_information() {
        let window = Rect { x: 5, y: 6, width: 700, height: 800 };
        assert_eq!(place(window, &[], 0), window);
    }

    #[test]
    fn saves_and_loads_the_main_window_and_keeps_other_entries() {
        let dir = std::env::temp_dir().join(format!("pas-window-state-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE);
        assert_eq!(load(&path), None, "missing file");
        let other = Saved { x: 1, y: 2, width: 900, height: 700, maximized: false };
        fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({ "version": 1, "windows": { "other": other } })).unwrap(),
        )
        .unwrap();
        let main = Saved { x: -2400, y: 100, width: 1600, height: 900, maximized: true };
        save(&path, main).unwrap();
        assert_eq!(load(&path), Some(main));
        assert_eq!(read(&path).windows.get("other"), Some(&other));
        fs::write(&path, b"{ not json").unwrap();
        assert_eq!(load(&path), None, "corrupt file is ignored");
        fs::write(&path, br#"{ "version": 2, "windows": {} }"#).unwrap();
        assert_eq!(load(&path), None, "unknown version is ignored");
        assert!(!sane(&Saved { width: 0, height: 900, ..main }));
        let _ = fs::remove_dir_all(&dir);
    }
}
