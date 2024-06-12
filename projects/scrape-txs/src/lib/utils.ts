export function waitRandomMs() {
  const randomMilliSeconds =
    Math.floor(Math.random() * (3000 - 1000 + 1)) + 1000;

  return new Promise<void>((resolve) => {
    console.log(`Waiting for ${randomMilliSeconds} ms...`);
    setTimeout(() => {
      console.log('Done waiting.');
      resolve();
    }, randomMilliSeconds);
  });
}

export function isLambda() {
  return !!process.env['AWS_LAMBDA_FUNCTION_NAME'];
}
