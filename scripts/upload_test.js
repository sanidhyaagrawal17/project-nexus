import fs from 'fs';
import path from 'path';

const API = 'http://localhost:5000/api/upload?max_upload_mb=1000';
// Pick the first CSV in the ml-pipeline/data directory
// Create a small test CSV payload to avoid duplicates
function makeSampleCsv() {
  const now = new Date().toISOString();
  return `timestamp,device,metric\n${now},dev-${Math.floor(Math.random()*10000)},${Math.floor(Math.random()*100)}\n`;
}
let buf = null;
async function main() {
  buf = Buffer.from(makeSampleCsv(), 'utf8');
  const form = new globalThis.FormData();
  const blob = new Blob([buf], { type: 'text/csv' });
  const fname = `test_upload_${Date.now()}.csv`;
  form.append('telemetryFile', blob, fname);

  const res = await fetch(API, { method: 'POST', body: form });
  console.log('Status:', res.status);
  const text = await res.text();
  console.log('Body:', text);
}

main().catch(err => { console.error(err); process.exit(1); });
