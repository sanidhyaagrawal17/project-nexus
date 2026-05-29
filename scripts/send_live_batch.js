(async () => {
  try {
    const payload = { events: [ { accountId: 'T1', amount: 100 }, { accountId: 'T2', amount: 200 } ] };
    const res = await fetch('http://localhost:5000/api/live-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    console.log('status', res.status);
    console.log(text);
  } catch (e) {
    console.error('error', e);
    process.exit(1);
  }
})();
