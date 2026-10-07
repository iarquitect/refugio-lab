// Posición solar (ecuaciones de SunCalc, licencia BSD-2-Clause).
// Ángulos de salida: azimut desde el norte en sentido horario y elevación geométrica.
const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = RAD * 23.4397;

export const SOLAR_LOCATION = Object.freeze({
  latitude: -(32 + 57 / 60 + 15.3 / 3600),
  longitude: -(69 + 11 / 60 + 45.6 / 3600),
  elevationMeters: null,
  source: 'Coordenadas 32°57′15,3″ S · 69°11′45,6″ O aportadas por Matías el 07-10-2026; cota no informada.'
});

export function mendozaNow(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Argentina/Mendoza', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function solarPosition(date, minutes, latitude = SOLAR_LOCATION.latitude, longitude = SOLAR_LOCATION.longitude) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(minutes) || minutes < 0 || minutes >= 1440 || !Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) throw Error('Fecha, hora o coordenadas solares inválidas.');
  const [year, month, day] = date.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day, 0, minutes + 180)); // Mendoza: UTC−3, sin horario de verano.
  if (new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== date) throw Error('Fecha solar inválida.');
  const days = (utc.getTime() / DAY_MS - 0.5 + J1970) - J2000;
  const meanAnomaly = RAD * (357.5291 + 0.98560028 * days);
  const center = RAD * (1.9148 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly) + 0.0003 * Math.sin(3 * meanAnomaly));
  const eclipticLongitude = meanAnomaly + center + RAD * 102.9372 + Math.PI;
  const declination = Math.asin(Math.sin(OBLIQUITY) * Math.sin(eclipticLongitude));
  const rightAscension = Math.atan2(Math.sin(eclipticLongitude) * Math.cos(OBLIQUITY), Math.cos(eclipticLongitude));
  const hourAngle = RAD * (280.16 + 360.9856235 * days + longitude) - rightAscension;
  const phi = RAD * latitude;
  const azimuthFromSouth = Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(phi) - Math.tan(declination) * Math.cos(phi));
  const elevation = Math.asin(Math.sin(phi) * Math.sin(declination) + Math.cos(phi) * Math.cos(declination) * Math.cos(hourAngle));
  return { azimuth: ((azimuthFromSouth / RAD + 180) % 360 + 360) % 360, elevation: elevation / RAD };
}

export function solarState(input = mendozaNow()) {
  const date = input?.date, minutes = input?.minutes;
  return { date, minutes, ...solarPosition(date, minutes) };
}

export function solarNoon(date, latitude = SOLAR_LOCATION.latitude, longitude = SOLAR_LOCATION.longitude) {
  let minute = 0, highest = -Infinity;
  for (let m = 0; m < 1440; m++) {
    const elevation = solarPosition(date, m, latitude, longitude).elevation;
    if (elevation > highest) { highest = elevation; minute = m; }
  }
  return minute;
}

export function solarTime(minutes) { return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`; }
