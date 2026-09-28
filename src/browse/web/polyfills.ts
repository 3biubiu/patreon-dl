// Safari before 17.4 (iOS 17.0 - 17.3) has no Promise.withResolvers, and
// pdf.js / react-pdf call it. Imported first from main.tsx so it is in place
// before any of their modules evaluate.
if (typeof (Promise as any).withResolvers !== 'function') {
  (Promise as any).withResolvers = function withResolvers<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

export {};
