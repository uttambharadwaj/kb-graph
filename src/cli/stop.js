import { existsSync, readFileSync, unlinkSync } from 'fs';
import { PID_PATH } from '../paths.js';

export function stop() {
  if (!existsSync(PID_PATH)) {
    console.log('Server is not running (no PID file found)');
    return;
  }

  const pid = parseInt(readFileSync(PID_PATH, 'utf-8').trim());

  try {
    process.kill(pid, 'SIGTERM');
    console.log(`Server stopped (PID ${pid})`);
  } catch (err) {
    if (err.code === 'ESRCH') {
      console.log('Server was not running (stale PID file)');
    } else {
      throw err;
    }
  }

  try { unlinkSync(PID_PATH); } catch {}
}
