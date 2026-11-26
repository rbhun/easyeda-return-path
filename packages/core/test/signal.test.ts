import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifySignal, formatHz, GENERIC, looksLikePowerNet, parseHz, riseAt, summariseSignal } from '../src/index.js';

test('signal: data lines are recognised from the net name, or failing that from a pin name', () => {
  const kind = (net: string, pins: string[] = []) => classifySignal(net, pins)?.type;
  assert.equal(kind('SC0'), 'i2c-clock', 'I²C mux channel');
  assert.equal(kind('SD3'), 'i2c-data');
  assert.equal(kind('RAD_SCL'), 'i2c-clock');
  assert.equal(kind('I2C1_SDA'), 'i2c-data');
  assert.equal(kind('USB_D+'), 'usb');
  assert.equal(kind('BCLK'), 'i2s-clock');
  assert.equal(kind('RAD_FS'), 'i2s-word');
  assert.equal(kind('MCLK'), 'i2s-mclk');
  assert.equal(kind('SCK'), 'spi-clock');
  assert.equal(kind('MOSI'), 'spi-data');
  assert.equal(kind('CS'), 'spi-select');
  assert.equal(kind('UART_TX'), 'uart');
  assert.equal(kind('SWDIO'), 'swd');
  assert.equal(kind('TXP'), 'ethernet');
  assert.equal(kind('OSC_IN'), 'clock');
  assert.equal(kind('$1N57'), undefined);
  assert.equal(kind('$1N57', ['PA9', 'SCL']), 'i2c-clock', 'an unnamed net takes the kind of a pin on it');
  assert.equal(kind('RESET'), undefined);
});

test('signal: speeds parse from what people type', () => {
  assert.equal(parseHz('400k'), 400e3);
  assert.equal(parseHz('12 MHz'), 12e6);
  assert.equal(parseHz('3,072M'), 3.072e6);
  assert.equal(parseHz('115200'), 115200);
  assert.equal(parseHz('115200 baud'), 115200);
  assert.equal(parseHz('fast'), undefined);
  assert.equal(formatHz(3.072e6), '3.072 MHz');
  assert.equal(formatHz(32768), '32.77 kHz');
});

test('signal: the speed sets the edge time, and the edge time whether the trace is a transmission line', () => {
  const i2c = classifySignal('SCL')!;
  assert.equal(riseAt(i2c, 400e3), 300, 'listed speed');
  assert.equal(riseAt(i2c, 600e3), 300, 'between two listed speeds: the slower one');
  assert.ok(riseAt(GENERIC, 200e6) <= 1, 'edges cannot be slower than a fifth of the period');
  const slow = summariseSignal('SCL', i2c, 400e3, 150);
  assert.ok(!slow.transmissionLine);
  assert.ok(slow.criticalMm > 8000);
  assert.match(slow.message, /SCL: I²C clock at 400 kHz\. Edges ≈ 300 ns \(open-drain.*\), so the signal has content up to ≈ 1\.2 MHz\. At 150 mm the trace is shorter than the 8\.5 m/);
  const usb = summariseSignal('USB_D+', classifySignal('USB_D+')!, 480e6, 40);
  assert.ok(usb.transmissionLine, '0.5 ns edges: anything over 14 mm is a transmission line');
  assert.match(usb.message, /acts as a transmission line/);
});

test('signal: negative rails are supply nets, not signals', () => {
  for (const n of ['-5VF', '-6V', '+5V', '3V3']) assert.ok(looksLikePowerNet(n), n);
});
