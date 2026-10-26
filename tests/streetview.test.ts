// The links between Garita and the street view of San Juan (src/core/streetview.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STREET_VIEW, inStreetView, parsePick, streetViewUrl } from '../src/core/streetview.ts';

test('the street view covers the municipio of San Juan only', () => {
  assert.equal(inStreetView(-66.1057, 18.4655), true);      // Plaza de Armas
  assert.equal(inStreetView(-66.0629, 18.4236), true);      // Milla de Oro
  assert.equal(inStreetView(-66.6141, 18.0111), false);     // Ponce
  assert.equal(inStreetView(NaN, 18.4), false);
});

test('a street-view link carries the place latitude first, the raised sea, and the way back', () => {
  const u = new URL(streetViewUrl(-66.1057123, 18.4655456, { sea: 1.234 })!);
  assert.equal(u.origin + u.pathname, STREET_VIEW.url);
  assert.equal(u.searchParams.get('ll'), '18.465546,-66.105712');
  assert.equal(u.searchParams.get('sea'), '1.23');
  assert.equal(u.searchParams.get('from'), 'garita');
  assert.equal(new URL(streetViewUrl(-66.1, 18.4, { sea: 0 })!).searchParams.has('sea'), false, 'present day: no sea');
  assert.equal(streetViewUrl(-66.6141, 18.0111), null);
});

test('?pick is longitude first and checked', () => {
  assert.deepEqual(parsePick('-66.070404,18.456644'), { lon: -66.070404, lat: 18.456644 });
  assert.equal(parsePick(''), null);
  assert.equal(parsePick('-66.07'), null);
  assert.equal(parsePick('18.45,-266.07'), null);
  assert.equal(parsePick('a,b'), null);
});
