import test from 'node:test';
import assert from 'node:assert/strict';
import { SOLAR_LOCATION, mendozaNow, solarNoon, solarPosition, solarState, solarTime } from '../src/solar.js';

const angularDifference = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

test('posición solar frente a la tabla SPA del NREL para 32,96° S y 69,20° O', () => {
  const cases = [
    ['2026-06-21', 12 * 60, 25.9, 28.9],
    ['2026-06-21', 13 * 60 + 40, 359.6, 33.6],
    ['2026-09-23', 13 * 60 + 30, 359.6, 57.3],
    ['2026-12-21', 13 * 60 + 35, 359.9, 80.5],
    ['2026-12-21', 17 * 60, 268.3, 44.3]
  ];
  for (const [date, minutes, azimuth, elevation] of cases) {
    const actual = solarPosition(date, minutes, -32.96, -69.20);
    assert.ok(angularDifference(actual.azimuth, azimuth) <= 0.3, `${date} ${solarTime(minutes)}: azimut ${actual.azimuth}`);
    assert.ok(Math.abs(actual.elevation - elevation) <= 0.3, `${date} ${solarTime(minutes)}: elevación ${actual.elevation}`);
  }
});

test('la hora oficial de Mendoza es independiente de la zona horaria del equipo', () => {
  assert.deepEqual(mendozaNow(new Date('2026-06-21T15:00:00Z')), { date: '2026-06-21', minutes: 720 });
  assert.deepEqual(mendozaNow(new Date('2026-12-22T02:00:00Z')), { date: '2026-12-21', minutes: 1380 });
});

test('mediodía y noche', () => {
  assert.equal(solarTime(solarNoon('2026-06-21', -32.96, -69.20)), '13:39');
  assert.ok(solarState({ date: '2026-06-21', minutes: 0 }).elevation < 0);
  assert.throws(() => solarPosition('2026-02-30', 720), /Fecha solar inválida/);
});

test('coordenadas aportadas por Matías en grados decimales', () => {
  assert.equal(SOLAR_LOCATION.latitude, -32.95425);
  assert.equal(SOLAR_LOCATION.longitude, -69.196);
  assert.equal(SOLAR_LOCATION.elevationMeters, null);
  assert.deepEqual(solarPosition('2026-06-21', 720), solarPosition('2026-06-21', 720, -32.95425, -69.196));
});
