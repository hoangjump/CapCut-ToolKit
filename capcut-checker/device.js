/**
 * Fake device fingerprint — sinh ngẫu nhiên mỗi request.
 * Giả lập s_v_web_id, web_id, user-agent, screen size, timezone.
 */

const CHROME_VERSIONS = ['120.0.0.0', '121.0.0.0', '122.0.0.0', '123.0.0.0', '124.0.0.0', '125.0.0.0'];
const PLATFORMS = ['Win32', 'MacIntel', 'Linux x86_64'];
const SCREENS = [
  [1920, 1080], [2560, 1440], [1366, 768], [1440, 900],
  [1536, 864], [1680, 1050], [3840, 2160], [1280, 720],
];
const TIMEZONES = [
  'Asia/Saigon', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Tokyo',
  'America/New_York', 'Europe/London', 'Asia/Jakarta',
];
const LANGS = ['en-US', 'en-GB', 'vi-VN', 'en'];

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randHex(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}
function randDigits(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 10);
  return s;
}

/** Sinh s_v_web_id giống format thật: verify_xxxxxxxx-xxxx-4xxx-xxxx-xxxxxxxxxxxx */
function genVerifyFp() {
  const hex = () => randHex(4);
  return `verify_${randHex(8)}-${hex()}-4${randHex(3)}-${hex()}-${randHex(12)}`;
}

/** Sinh web_id giống format thật: 19 chữ số */
function genWebId() { return '7' + randDigits(18); }

export function newDevice() {
  const chromeVer = rand(CHROME_VERSIONS);
  const platform = rand(PLATFORMS);
  const [sw, sh] = rand(SCREENS);
  const timezone = rand(TIMEZONES);
  const lang = rand(LANGS);
  const verifyFp = genVerifyFp();
  const webId = genWebId();

  const os = platform === 'Win32' ? 'Windows NT 10.0; Win64; x64'
    : platform === 'MacIntel' ? 'Macintosh; Intel Mac OS X 10_15_7'
    : 'X11; Linux x86_64';

  const ua = `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`;

  return {
    ua,
    verifyFp,
    webId,
    platform,
    lang,
    timezone,
    screenWidth: sw,
    screenHeight: sh,
    chromeVer,
  };
}
