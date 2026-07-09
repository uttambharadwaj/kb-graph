import { existsSync, readFileSync } from 'fs';
import { getStats, getDocumentCount } from '../db.js';
import { PID_PATH } from '../paths.js';

export function status() {
  // Check server status
  let serverRunning = false;
  let pid = null;
  if (existsSync(PID_PATH)) {
    pid = parseInt(readFileSync(PID_PATH, 'utf-8').trim());
    try {
      process.kill(pid, 0); // Check if process exists
      serverRunning = true;
    } catch {
      serverRunning = false;
    }
  }

  console.log('Knowledge Base Status');
  console.log('=====================');
  console.log(`Server: ${serverRunning ? `running (PID ${pid})` : 'stopped'}`);

  try {
    const stats = getStats();
    console.log(`Documents: ${stats.count}`);
    console.log(`Total Size: ${formatSize(stats.totalSize || 0)}`);
    console.log(`DB Size: ${formatSize(stats.dbFileSize || 0)}`);
  } catch {
    console.log('Database: not initialized');
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}
