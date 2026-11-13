/**
 * The room screen's few texts, in the languages SingVerse speaks (Spanish and
 * English), following Nightingale's interface language when it is one of them.
 */

const STRINGS = {
  en: {
    start: 'Start the party',
    startHint: 'Tap once so the browser lets this screen play music and use the microphone.',
    join: 'Scan to join and queue songs',
    code: 'Room code',
    empty: 'The queue is empty. Grab your phone and queue a song!',
    upNext: 'Up next',
    nowSinging: 'Get ready',
    startsIn: 'Starts in {n} s',
    startNow: 'Sing now',
    skip: 'Skip',
    downloading: 'Getting the song… {percent}%',
    preparing: 'Getting the song…',
    failed: 'This song could not be loaded: {error}',
    queue: 'Queue',
    scores: 'Latest scores',
    skipped: 'Skipped',
    closed: 'This room is closed.',
    offline: 'Can’t reach SingVerse. Retrying…',
    signedOut: 'This screen’s session ended. Open it again from your room on SingVerse.',
    micHint: 'Sing into this device’s microphone: the score goes to whoever queued the song.',
    credit: 'Powered by Nightingale (GPL-3.0), modified for SingVerse. Source:',
  },
  es: {
    start: 'Empezar la fiesta',
    startHint:
      'Toca una vez para que el navegador deje a esta pantalla reproducir música y usar el micrófono.',
    join: 'Escanea para unirte y encolar canciones',
    code: 'Código de la sala',
    empty: 'La cola está vacía. ¡Toma tu teléfono y encola una canción!',
    upNext: 'Sigue',
    nowSinging: 'Prepárate',
    startsIn: 'Empieza en {n} s',
    startNow: 'Cantar ya',
    skip: 'Saltar',
    downloading: 'Preparando la canción… {percent}%',
    preparing: 'Preparando la canción…',
    failed: 'No se pudo cargar esta canción: {error}',
    queue: 'Cola',
    scores: 'Últimos puntajes',
    skipped: 'Saltada',
    closed: 'Esta sala está cerrada.',
    offline: 'No se puede conectar con SingVerse. Reintentando…',
    signedOut: 'La sesión de esta pantalla terminó. Ábrela de nuevo desde tu sala en SingVerse.',
    micHint: 'Canta al micrófono de este equipo: el puntaje es para quien encoló la canción.',
    credit: 'Hecho con Nightingale (GPL-3.0), modificado para SingVerse. Código fuente:',
  },
} as const;

export type RoomStringKey = keyof (typeof STRINGS)['en'];

export function roomStrings(language: string | null | undefined) {
  const lang = (language ?? navigator.language).toLowerCase().startsWith('en') ? 'en' : 'es';
  return (key: RoomStringKey, values: Record<string, string | number> = {}) =>
    STRINGS[lang][key].replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''));
}
