const rawEnvBackendUrl = process.env.REACT_APP_BACKEND_URL?.trim();

const normalizeUrl = (value) => value?.replace(/\/+$/, '');

const getDefaultBackendUrl = () => {
  if (typeof window === 'undefined' || !window.location) {
    return 'http://127.0.0.1:8000';
  }

  const { origin, hostname, protocol } = window.location;
  const isLocalhost = ['localhost', '127.0.0.1'].includes(hostname);
  const isPrivateLanHost = /^(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})$/.test(hostname);

  if (isLocalhost || isPrivateLanHost) {
    return `${protocol}//${hostname}:8000`;
  }

  return origin;
};

export const BACKEND_URL = normalizeUrl(rawEnvBackendUrl) || getDefaultBackendUrl();
