const rawEnvBackendUrl = process.env.REACT_APP_BACKEND_URL?.trim();

const normalizeUrl = (value) => value?.replace(/\/+$/, '');

const getDefaultBackendUrl = () => {
  if (typeof window === 'undefined' || !window.location) {
    return 'http://127.0.0.1:8000';
  }

  const { origin, hostname, protocol } = window.location;
  const isLocalhost = ['localhost', '127.0.0.1'].includes(hostname);

  if (isLocalhost) {
    return `${protocol}//${hostname}:8000`;
  }

  return origin;
};

export const BACKEND_URL = normalizeUrl(rawEnvBackendUrl) || getDefaultBackendUrl();
