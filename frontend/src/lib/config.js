const browserHostname =
  typeof window !== 'undefined' && window.location?.hostname
    ? window.location.hostname
    : '127.0.0.1';

const browserProtocol =
  typeof window !== 'undefined' && window.location?.protocol
    ? window.location.protocol
    : 'http:';

export const BACKEND_URL =
  process.env.REACT_APP_BACKEND_URL ||
  `${browserProtocol}//${browserHostname}:8000`;
