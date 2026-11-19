// RAHIN — راهنمای صوتی فارسی (Web Speech API + پشتیبانی نیتیو)
import { faNum } from './domain.js';

const TURN_PHRASES = {
  depart: 'حرکت کنید',
  'slight-right': 'به سمت راست متمایل شوید',
  right: 'به راست بپیچید',
  'sharp-right': 'تند به راست بپیچید',
  'uturn-right': 'دور بزنید',
  'uturn-left': 'دور بزنید',
  'sharp-left': 'تند به چپ بپیچید',
  left: 'به چپ بپیچید',
  'slight-left': 'به سمت چپ متمایل شوید',
  continue: 'مستقیم ادامه دهید',
  'ramp-straight': 'به رمپ وارد شوید',
  'ramp-right': 'از رمپ سمت راست وارد شوید',
  'ramp-left': 'از رمپ سمت چپ وارد شوید',
  'exit-right': 'از خروجی سمت راست خارج شوید',
  'exit-left': 'از خروجی سمت چپ خارج شوید',
  'stay-straight': 'در لاین فعلی ادامه دهید',
  'stay-right': 'در لاین راست بمانید',
  'stay-left': 'در لاین چپ بمانید',
  merge: 'وارد مسیر اصلی شوید',
  'roundabout-enter': 'وارد میدان شوید',
  'roundabout-exit': 'از میدان خارج شوید',
  ferry: 'از شناور استفاده کنید',
  arrive: 'به مقصد رسیدید',
  other: 'ادامه دهید',
};

const TURN_ICONS = {
  depart: '⬆️', 'slight-right': '↗️', right: '➡️', 'sharp-right': '⤵️',
  'uturn-right': '↩️', 'uturn-left': '↪️', 'sharp-left': '⤴️', left: '⬅️', 'slight-left': '↖️',
  continue: '⬆️', 'ramp-straight': '⬆️', 'ramp-right': '↗️', 'ramp-left': '↖️',
  'exit-right': '➡️', 'exit-left': '⬅️', 'stay-straight': '⬆️', 'stay-right': '↗️', 'stay-left': '↖️',
  merge: '⤴️', 'roundabout-enter': '🔄', 'roundabout-exit': '🔄', ferry: '⛴️', arrive: '🏁', other: '⬆️',
};

export function turnIcon(kind) {
  return TURN_ICONS[kind] || '⬆️';
}

export function turnPhrase(maneuver, distanceMeters = null, { roundaboutExit = null } = {}) {
  if (!maneuver) return '';
  const phrase = TURN_PHRASES[maneuver.kind] || TURN_PHRASES.other;
  const withDist = distanceMeters != null ? `تا ${distToSpeech(distanceMeters)} دیگر ` : '';
  let txt = `${withDist}${phrase}`;
  if (maneuver.kind === 'roundabout-enter' && roundaboutExit) {
    txt = `${withDist}وارد میدان شوید و از خروجی ${faNum(roundaboutExit)} خارج شوید`;
  }
  const street = (maneuver.street_fa || '').split('،')[0];
  if (street && (phrase.includes('بپیچید') || phrase.includes('ادامه') || phrase.includes('وارد'))) {
    txt = `${txt}، به سمت ${street}`;
  }
  if (maneuver.kind === 'arrive') {
    txt = 'به مقصد رسیدید. سفر خوبی داشته باشید.';
  }
  return txt;
}

function distToSpeech(m) {
  const r = Math.max(10, Math.round(m / 10) * 10);
  return r < 1000 ? `${faNum(r)} متر` : `${faNum((r / 1000).toFixed(r < 10000 ? 1 : 0))} کیلومتر`;
}

class VoiceGuide {
  constructor() {
    this.enabled = true;
    this.lead = 'normal';
    this.lang = 'fa-IR';
    this.synth = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;
    this.voices = [];
    this._lastSpokenKey = '';
    this._spokenAt = 0;
    if (this.synth) {
      const load = () => {
        this.voices = this.synth.getVoices();
      };
      this.voices = this.synth.getVoices();
      if (!this.voices.length) this.synth.onvoiceschanged = load;
    }
  }

  configure({ enabled, lead, lang } = {}) {
    if (enabled != null) this.enabled = enabled;
    if (lead) this.lead = lead;
    if (lang) this.lang = lang;
  }

  pickVoice() {
    const prefers = ['fa', 'fa-ir', 'fa_ir'];
    return (
      this.voices.find((v) => prefers.some((p) => v.lang?.toLowerCase().replace('_', '-') === p || v.lang?.toLowerCase() === p)) ||
      this.voices.find((v) => /persian|farsi|iran/i.test(v.name)) ||
      null
    );
  }

  speak(text, { priority = 0 } = {}) {
    if (!text || !this.enabled) return;
    if (window.RAHINNative?.announce) {
      try {
        window.RAHINNative.announce(text, this.lang);
        return;
      } catch {
        // fallthrough
      }
    }
    if (!this.synth) return;
    if (priority < 1) {
      const now = Date.now();
      if (text === this._lastSpokenKey && now - this._spokenAt < 12000) return;
      this._lastSpokenKey = text;
      this._spokenAt = now;
    }
    const u = new SpeechSynthesisUtterance(text);
    const v = this.pickVoice();
    if (v) u.voice = v;
    u.lang = this.lang;
    u.rate = 0.95;
    u.pitch = 1;
    if (priority >= 2) this.synth.cancel();
    this.synth.speak(u);
  }

  announcePlan(distanceMeters) {
    const d = distanceMeters;
    if (this.lead === 'early') return d >= 500 ? [700, 350, 120] : [];
    if (this.lead === 'late') return d >= 300 ? [300, 90] : [];
    return d >= 400 ? [500, 250, 80] : [];
  }

  announceManeuver(maneuver, distanceMeters) {
    const text = turnPhrase(maneuver, distanceMeters);
    this.speak(text, { priority: 1 });
  }

  announceArrive() {
    this.speak('به مقصد رسیدید', { priority: 2 });
  }

  announceReroute() {
    this.speak('مسیر جدید محاسبه شد', { priority: 2 });
  }

  stop() {
    if (this.synth) this.synth.cancel();
    try {
      window.RAHINNative?.stopAnnounce?.();
    } catch {
      // ignore
    }
  }
}

export const voice = new VoiceGuide();
