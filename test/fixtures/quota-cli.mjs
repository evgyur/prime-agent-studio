if (process.argv.includes('--version')) console.log('0.0.0-test');
else {
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;
  const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
  emit({ type: 'session', id: 'quota-session' });
  const response = await fetch(process.env.STUDIO_TEST_QUOTA_URL);
  emit({ type: 'studio_quota', quota: { status: response.status, headers: Object.fromEntries(response.headers) } });
  emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: prompt === 'unauthorized' ? '401 Unauthorized' : `${response.status} Too Many Requests` } });
  if (prompt === 'recover') emit({ type: 'auto_retry_end', success: true });
}
