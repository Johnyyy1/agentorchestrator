export const loopbackGuardFilename = "loopback-guard.cjs";

// Guard the public Node listen API for fixtures, inherited by npm/tsx children.
// It is deliberately not presented as a hostile-code/native-runtime boundary:
// code can replace the API or unset NODE_OPTIONS. Seatbelt still confines egress.
export const loopbackGuard = `
const net = require('node:net');
const original = net.Server.prototype.listen;
net.Server.prototype.listen = function(...args) {
  const first = args[0];
  const unix = typeof first === 'string' && !/^\\d+$/.test(first)
    || first && typeof first === 'object' && typeof first.path === 'string';
  if (unix) return original.apply(this, args);
  let host = first && typeof first === 'object' ? first.host : args[1];
  const port = first && typeof first === 'object' ? first.port : first;
  if (host === 'localhost') {
    host = '127.0.0.1';
    if (typeof first === 'object') args[0] = { ...first, host };
    else args[1] = host;
  }
  if (port === undefined || host !== '127.0.0.1' && host !== '::1') {
    const error = new Error('listen EPERM: verifier Node guard requires explicit 127.0.0.1 or ::1');
    error.code = 'EPERM'; error.syscall = 'listen';
    throw error;
  }
  return original.apply(this, args);
};
`;
