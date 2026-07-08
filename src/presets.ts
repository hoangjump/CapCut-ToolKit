import {
  defaultAntiDetect,
  defaultBrowserSettings,
  type AntiDetectConfig,
  type BrowserSettings,
  type ProjectRecord,
  type ProxyRotation,
} from './types.js';

export interface ProfilePreset {
  id: string;
  label: string;
  description: string;
  antiDetect: AntiDetectConfig;
  browser: BrowserSettings;
  proxyRotation?: ProxyRotation;
}

export interface ProjectPreset {
  id: string;
  label: string;
  description: string;
  project: Omit<ProjectRecord, 'id' | 'createdAt'>;
}

export const profilePresets: ProfilePreset[] = [
  {
    id: 'default-camoufox',
    label: 'Default Camoufox',
    description: 'Cấu hình mặc định an toàn, giữ fingerprint Camoufox tự sinh.',
    antiDetect: defaultAntiDetect(),
    browser: defaultBrowserSettings(),
  },
  {
    id: 'capcut-signup',
    label: 'CapCut Signup',
    description: 'Profile sạch cho flow đăng ký CapCut với geo/proxy đồng bộ.',
    antiDetect: {
      ...defaultAntiDetect(),
      language: 'base-on-ip',
      webrtc: 'base-on-ip',
      geoip: true,
      maskMediaDevices: true,
    },
    browser: {
      ...defaultBrowserSettings(),
      clearCacheOnStart: true,
      restorePreviousSession: false,
    },
    proxyRotation: {
      mode: 'pool',
      pool: { tags: [], liveOnly: true },
      rotateOnOpen: true,
      rotateOnFailure: true,
    },
  },
  {
    id: 'debug-fast',
    label: 'Debug Fast',
    description: 'Profile nhẹ để debug UI/selector nhanh, không ép geoip.',
    antiDetect: {
      ...defaultAntiDetect(),
      geoip: false,
      screen: '1280x720',
    },
    browser: {
      ...defaultBrowserSettings(),
      clearCacheOnStart: false,
    },
  },
];

export const projectPresets: ProjectPreset[] = [
  {
    id: 'auto-capcut',
    label: 'Auto Capcut',
    description: 'Tạo profile tạm, mua mail, đăng ký CapCut và bắt checkout.',
    project: {
      name: 'Auto Capcut',
      flowName: 'capcut-signin',
      profileIds: [],
      concurrency: 2,
      ephemeralCount: 1,
      buyAccountType: '5',
      buyQuality: '44158',
      ephemeralProxyPool: { tags: [], liveOnly: true },
      note: '',
    },
  },
  {
    id: 'demo',
    label: 'Demo',
    description: 'Smoke-test profile/proxy/fingerprint bằng flow demo.',
    project: {
      name: 'Demo',
      flowName: 'demo',
      profileIds: [],
      concurrency: 1,
      ephemeralCount: 1,
      note: '',
    },
  },
];
