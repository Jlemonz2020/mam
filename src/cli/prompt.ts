import readline from 'node:readline';

/** 普通输入 */
export function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** 隐藏输入（口令） */
export function askPassword(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (rl as any)._writeToOutput = () => undefined; // 静默回显
  return new Promise((resolve) => {
    rl.question(`${question} `, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}
