import { spawn } from 'node:child_process';

export const handler = async () => {
  const process = spawn('bun', ['run', './src/console.ts']);
  process.stdout.on('data', (data) => {
    console.log(data.toString());
  });
  process.stderr.on('data', (data) => {
    console.error(data.toString());
  });
  await new Promise((resolve) => {
    process.on('exit', () => {
      resolve();
    });
  });
};
