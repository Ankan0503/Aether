export type PushStatus = {
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
  subscribed: boolean;
  configured: boolean;
};

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

const authHeaders = (token: string): HeadersInit => ({
  'Content-Type': 'application/json',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

const urlBase64ToUint8Array = (base64String: string) => {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }

  return outputArray;
};

export const isPushSupported = () => (
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window &&
  window.isSecureContext
);

export const registerAetherServiceWorker = async () => {
  if (!('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker.register('/sw.js');
};

const getVapidPublicKey = async () => {
  const res = await fetch(`${API_URL}/api/notifications/public-key/`);
  if (!res.ok) {
    throw new Error('Unable to load notification configuration.');
  }
  return res.json() as Promise<{ configured: boolean; publicKey: string }>;
};

export const getPushStatus = async (): Promise<PushStatus> => {
  if (!isPushSupported()) {
    return { supported: false, permission: 'unsupported', subscribed: false, configured: false };
  }

  const [registration, config] = await Promise.all([
    navigator.serviceWorker.ready.catch(() => registerAetherServiceWorker()),
    getVapidPublicKey().catch(() => ({ configured: false, publicKey: '' })),
  ]);
  const subscription = registration ? await registration.pushManager.getSubscription() : null;

  return {
    supported: true,
    permission: Notification.permission,
    subscribed: !!subscription,
    configured: config.configured,
  };
};

export const subscribeToPushNotifications = async (token: string) => {
  if (!isPushSupported()) {
    throw new Error('Push notifications require HTTPS or localhost and a supported browser.');
  }

  const config = await getVapidPublicKey();
  if (!config.configured || !config.publicKey) {
    throw new Error('Django Web Push VAPID keys are not configured.');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notification permission was not granted.');
  }

  const registration = await registerAetherServiceWorker();
  if (!registration) {
    throw new Error('Service worker registration failed.');
  }

  const existing = await registration.pushManager.getSubscription();
  const subscription = existing || await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(config.publicKey),
  });

  const res = await fetch(`${API_URL}/api/notifications/subscribe/`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(subscription),
  });

  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Unable to save push subscription.');
  }

  return subscription;
};

export const unsubscribeFromPushNotifications = async (token: string) => {
  if (!isPushSupported()) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();

  if (subscription) {
    await fetch(`${API_URL}/api/notifications/unsubscribe/`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    await subscription.unsubscribe();
  }
};

export const sendTestNotification = async (token: string) => {
  const res = await fetch(`${API_URL}/api/notifications/test/`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.reason) {
    throw new Error(payload.reason || payload.error || 'Test notification failed.');
  }
  return payload;
};

export const sendHazardNotification = async (
  token: string,
  payload: {
    hazard_type: string;
    severity: string;
    risk_score?: number;
    title?: string;
    message: string;
  },
) => {
  if (!token) return;

  await fetch(`${API_URL}/api/notifications/hazard/`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  }).catch((err) => {
    console.error('Failed to request hazard push notification:', err);
  });
};

export const showImmediateHazardNotification = async (payload: {
  title: string;
  message: string;
  tag: string;
}) => {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const options = {
    body: payload.message,
    icon: '/icons/aether-icon-192.png',
    badge: '/icons/aether-icon-192.png',
    tag: payload.tag,
    renotify: true,
    requireInteraction: true,
  } as NotificationOptions & { renotify: boolean };

  try {
    const registration = 'serviceWorker' in navigator
      ? await navigator.serviceWorker.ready
      : null;
    if (registration) {
      await registration.showNotification(payload.title, options);
      return;
    }
  } catch (err) {
    console.error('Failed to show immediate service-worker notification:', err);
  }

  new Notification(payload.title, options);
};
