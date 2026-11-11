// The Powerhouse voice hook (docs/DESIGN.md §1): the shout bubble calls speak() with the same text
// it shows. It does nothing today; a provider (system speech, a TTS API) can be plugged in later
// without touching the page. Nothing here may send text anywhere until he turns a voice on.
export interface VoiceProvider { speak(text: string): void }

let provider: VoiceProvider | null = null;
export function setVoiceProvider(p: VoiceProvider | null): void { provider = p; }
export function speak(text: string): void { provider?.speak(text); }
