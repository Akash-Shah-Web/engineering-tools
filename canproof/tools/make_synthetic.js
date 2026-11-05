#!/usr/bin/env node
/*
 * Generates the SYNTHETIC demo dataset (clearly labelled, not real data):
 *   data/synthetic/demo_vehicle.dbc   — an original, unbranded 500 kbit/s powertrain/chassis/body network
 *   data/synthetic/demo_vehicle.log   — candump-format trace produced by CANProof's own bus simulator
 *
 * The trace is SIMULATED from the DBC: it cannot validate the analysis
 * (it would be circular). It exists so the UI has a self-consistent example
 * and so the trace-measurement code can be tested against known ground truth.
 * Deterministic: fixed seed.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('../src/core.js');

const BITRATE = 500000;
// [name, id, extended, dlc, sender, cycle ms, receivers, signals[], opts]
// signal: [name, len, signed, factor, offset, min, max, unit, wave, byteOrder]
// wave: 'counter' | 'sine:<period s>:<amp>:<mean>' | 'walk:<step>' | 'const:<v>' | 'enum:<n>'
const NODES = ['ECM', 'TCM', 'ESC', 'EPS', 'BCM', 'IPC', 'ADAS', 'GW', 'SRS', 'HVAC'];
const MSGS = [
  ['SRS_Status', 0x050, false, 4, 'SRS', 20, ['BCM', 'IPC', 'GW'], [['CrashDetected', 1, 0, 1, 0, 0, 1, '', 'const:0'], ['BeltDriver', 1, 0, 1, 0, 0, 1, '', 'const:1'], ['SRS_Counter', 4, 0, 1, 0, 0, 15, '', 'counter'], ['SRS_Checksum', 8, 0, 1, 0, 0, 255, '', 'walk:97']]],
  ['ESC_WheelSpeeds', 0x0A0, false, 8, 'ESC', 10, ['ECM', 'TCM', 'EPS', 'ADAS', 'IPC'], [['WhlSpd_FL', 16, 0, 0.01, 0, 0, 655.35, 'km/h', 'sine:12:40:60'], ['WhlSpd_FR', 16, 0, 0.01, 0, 0, 655.35, 'km/h', 'sine:12:40:60.4'], ['WhlSpd_RL', 16, 0, 0.01, 0, 0, 655.35, 'km/h', 'sine:12:40:59.8'], ['WhlSpd_RR', 16, 0, 0.01, 0, 0, 655.35, 'km/h', 'sine:12:40:60.1']]],
  ['ESC_Dynamics', 0x0B0, false, 8, 'ESC', 10, ['ADAS', 'EPS', 'ECM'], [['YawRate', 16, 1, 0.01, 0, -327.68, 327.67, 'deg/s', 'sine:7:8:0', 'motorola'], ['LatAccel', 16, 1, 0.001, 0, -32.768, 32.767, 'm/s2', 'sine:7:2.5:0', 'motorola'], ['LongAccel', 16, 1, 0.001, 0, -32.768, 32.767, 'm/s2', 'sine:12:1.5:0', 'motorola'], ['ESC_Counter', 4, 0, 1, 0, 0, 15, '', 'counter']]],
  ['ECM_Engine1', 0x0C0, false, 8, 'ECM', 10, ['TCM', 'ESC', 'IPC', 'HVAC'], [['EngSpeed', 16, 0, 0.25, 0, 0, 16383.75, 'rpm', 'sine:12:1500:2200'], ['PedalPos', 8, 0, 0.4, 0, 0, 100, '%', 'sine:12:30:35'], ['EngTorqueAct', 12, 1, 0.5, 0, -1024, 1023.5, 'Nm', 'sine:12:120:140'], ['ECM_Counter', 4, 0, 1, 0, 0, 15, '', 'counter'], ['ECM_Checksum', 8, 0, 1, 0, 0, 255, '', 'walk:31']]],
  ['TCM_Status', 0x0D0, false, 8, 'TCM', 10, ['ECM', 'IPC', 'ESC'], [['GearActual', 4, 0, 1, 0, 0, 9, '', 'enum:7'], ['GearTarget', 4, 0, 1, 0, 0, 9, '', 'enum:7'], ['TurbineSpeed', 16, 0, 0.25, 0, 0, 16383.75, 'rpm', 'sine:12:1200:2000'], ['TorqueReq', 12, 1, 0.5, 0, -1024, 1023.5, 'Nm', 'sine:12:60:80'], ['TCM_Counter', 4, 0, 1, 0, 0, 15, '', 'counter']]],
  ['EPS_Steering', 0x0E0, false, 8, 'EPS', 10, ['ESC', 'ADAS'], [['SteerAngle', 16, 1, 0.1, 0, -3276.8, 3276.7, 'deg', 'sine:7:90:0', 'motorola'], ['SteerRate', 16, 1, 1, 0, -32768, 32767, 'deg/s', 'sine:7:80:0', 'motorola'], ['DriverTorque', 12, 1, 0.01, 0, -20.48, 20.47, 'Nm', 'sine:7:3:0', 'motorola'], ['EPS_Counter', 4, 0, 1, 0, 0, 15, '', 'counter']]],
  ['ADAS_Request', 0x0F0, false, 8, 'ADAS', 20, ['ESC', 'EPS', 'ECM'], [['AccelRequest', 12, 1, 0.005, 0, -10.24, 10.235, 'm/s2', 'sine:20:1:0'], ['SteerTorqueReq', 12, 1, 0.01, 0, -20.48, 20.47, 'Nm', 'sine:9:1:0'], ['LKA_Active', 1, 0, 1, 0, 0, 1, '', 'const:1'], ['ACC_Active', 1, 0, 1, 0, 0, 1, '', 'const:1'], ['ADAS_Counter', 4, 0, 1, 0, 0, 15, '', 'counter']]],
  ['ECM_Engine2', 0x120, false, 8, 'ECM', 20, ['IPC', 'TCM', 'HVAC'], [['CoolantTemp', 8, 0, 1, -40, -40, 215, 'degC', 'walk:0.05:88'], ['OilTemp', 8, 0, 1, -40, -40, 215, 'degC', 'walk:0.05:95'], ['IntakeAirTemp', 8, 0, 1, -40, -40, 215, 'degC', 'walk:0.05:30'], ['ThrottlePos', 8, 0, 0.4, 0, 0, 100, '%', 'sine:12:30:35'], ['BaroPressure', 8, 0, 0.5, 0, 0, 127.5, 'kPa', 'const:101']]],
  ['TCM_Shift', 0x130, false, 4, 'TCM', 20, ['IPC'], [['ShiftInProgress', 1, 0, 1, 0, 0, 1, '', 'enum:2'], ['ClutchSlip', 16, 0, 0.1, 0, 0, 6553.5, 'rpm', 'walk:2:20']]],
  ['ADAS_Objects', 0x160, false, 8, 'ADAS', 50, ['IPC', 'GW'], [['LeadDistance', 12, 0, 0.1, 0, 0, 409.5, 'm', 'sine:20:20:45'], ['LeadRelSpeed', 12, 1, 0.05, 0, -102.4, 102.35, 'm/s', 'sine:20:3:0'], ['LaneOffset', 12, 1, 0.01, 0, -20.48, 20.47, 'm', 'sine:15:0.3:0'], ['LaneCurv', 16, 1, 0.00001, 0, -0.32768, 0.32767, '1/m', 'sine:15:0.002:0']]],
  ['ESC_Brake', 0x1A0, false, 6, 'ESC', 20, ['ECM', 'IPC', 'BCM'], [['BrakePressure', 12, 0, 0.1, 0, 0, 409.5, 'bar', 'sine:12:20:15'], ['BrakePedal', 1, 0, 1, 0, 0, 1, '', 'enum:2'], ['ABS_Active', 1, 0, 1, 0, 0, 1, '', 'const:0'], ['VehSpeed', 16, 0, 0.01, 0, 0, 655.35, 'km/h', 'sine:12:40:60']]],
  ['BCM_Lights', 0x2A0, false, 4, 'BCM', 100, ['IPC', 'GW'], [['LowBeam', 1, 0, 1, 0, 0, 1, '', 'const:1'], ['HighBeam', 1, 0, 1, 0, 0, 1, '', 'const:0'], ['TurnLeft', 1, 0, 1, 0, 0, 1, '', 'enum:2'], ['TurnRight', 1, 0, 1, 0, 0, 1, '', 'const:0'], ['BrakeLight', 1, 0, 1, 0, 0, 1, '', 'enum:2'], ['AmbientLight', 8, 0, 1, 0, 0, 255, 'lux', 'walk:1:120']]],
  ['BCM_Doors', 0x2B0, false, 2, 'BCM', 100, ['IPC', 'GW', 'SRS'], [['DoorFL', 1, 0, 1, 0, 0, 1, '', 'const:0'], ['DoorFR', 1, 0, 1, 0, 0, 1, '', 'const:0'], ['DoorRL', 1, 0, 1, 0, 0, 1, '', 'const:0'], ['DoorRR', 1, 0, 1, 0, 0, 1, '', 'const:0'], ['Trunk', 1, 0, 1, 0, 0, 1, '', 'const:0'], ['LockState', 2, 0, 1, 0, 0, 3, '', 'const:2']]],
  ['HVAC_Status', 0x320, false, 6, 'HVAC', 100, ['ECM', 'IPC'], [['CabinTemp', 8, 0, 0.5, -20, -20, 107.5, 'degC', 'walk:0.02:22'], ['SetTemp', 8, 0, 0.5, -20, -20, 107.5, 'degC', 'const:21'], ['FanLevel', 4, 0, 1, 0, 0, 15, '', 'const:3'], ['ACCompressorReq', 1, 0, 1, 0, 0, 1, '', 'const:1'], ['CompressorLoad', 8, 0, 0.1, 0, 0, 25.5, 'kW', 'walk:0.01:1.2']]],
  ['IPC_Display', 0x3A0, false, 8, 'IPC', 100, ['GW'], [['Odometer', 24, 0, 0.1, 0, 0, 1677721.5, 'km', 'walk:0.002:24816.2'], ['FuelLevel', 8, 0, 0.4, 0, 0, 100, '%', 'walk:0.001:63'], ['DisplaySpeed', 16, 0, 0.01, 0, 0, 655.35, 'km/h', 'sine:12:40:60'], ['IPC_Counter', 4, 0, 1, 0, 0, 15, '', 'counter']]],
  ['ECM_Fuel', 0x3C0, false, 8, 'ECM', 100, ['IPC'], [['FuelRate', 16, 0, 0.05, 0, 0, 3276.75, 'L/h', 'sine:12:4:6'], ['FuelUsed', 24, 0, 0.001, 0, 0, 16777.215, 'L', 'walk:0.0002:12.3'], ['BatteryVoltage', 8, 0, 0.1, 0, 0, 25.5, 'V', 'walk:0.01:14.1']]],
  ['GW_VehicleState', 0x400, false, 8, 'GW', 200, ['BCM', 'IPC', 'HVAC'], [['PowerMode', 3, 0, 1, 0, 0, 7, '', 'const:4'], ['WakeReason', 4, 0, 1, 0, 0, 15, '', 'const:2'], ['NetworkMgmt', 8, 0, 1, 0, 0, 255, '', 'const:85'], ['GW_Counter', 4, 0, 1, 0, 0, 15, '', 'counter']]],
  ['SRS_Config', 0x450, false, 4, 'SRS', 1000, ['GW'], [['PassengerOccupied', 1, 0, 1, 0, 0, 1, '', 'const:1'], ['AirbagLamp', 1, 0, 1, 0, 0, 1, '', 'const:0'], ['SRS_Version', 8, 0, 1, 0, 0, 255, '', 'const:42']]],
  ['TCM_Temps', 0x470, false, 4, 'TCM', 1000, ['IPC'], [['TransOilTemp', 8, 0, 1, -40, -40, 215, 'degC', 'walk:0.05:80'], ['ClutchTemp', 8, 0, 1, -40, -40, 215, 'degC', 'walk:0.05:90']]],
  ['ADAS_Diag', 0x18DAF1A0, true, 8, 'ADAS', 1000, ['GW'], [['DiagCounter', 8, 0, 1, 0, 0, 255, '', 'counter'], ['CamTemp', 8, 0, 1, -40, -40, 215, 'degC', 'walk:0.05:45'], ['RadarBlind', 1, 0, 1, 0, 0, 1, '', 'const:0']]],
  ['ECM_Emissions', 0x18FEF100, true, 8, 'ECM', 100, ['GW'], [['Lambda', 16, 0, 0.0001, 0, 0, 6.5535, '', 'sine:5:0.03:1'], ['CatalystTemp', 12, 0, 0.5, 0, 0, 2047.5, 'degC', 'walk:0.2:520'], ['O2Sensor', 8, 0, 0.005, 0, 0, 1.275, 'V', 'sine:2:0.4:0.45']]],
  ['HVAC_Climate', 0x18FF5050, true, 8, 'HVAC', 500, ['GW', 'IPC'], [['OutsideTemp', 8, 0, 0.5, -40, -40, 87.5, 'degC', 'walk:0.01:14'], ['Humidity', 8, 0, 0.4, 0, 0, 100, '%', 'walk:0.05:45'], ['SunLoad', 8, 0, 4, 0, 0, 1020, 'W/m2', 'walk:0.5:300']]],
  ['ECM_Engine3', 0x0C8, false, 8, 'ECM', 10, ['TCM', 'ESC'], [['TorqueLimit', 12, 1, 0.5, 0, -1024, 1023.5, 'Nm', 'sine:12:50:300'], ['IdleTarget', 12, 0, 0.5, 0, 0, 2047.5, 'rpm', 'const:750'], ['EngState', 3, 0, 1, 0, 0, 7, '', 'const:3'], ['ECM3_Counter', 4, 0, 1, 0, 0, 15, '', 'counter'], ['ECM3_Checksum', 8, 0, 1, 0, 0, 255, '', 'walk:61']]],
  ['ESC_WheelPulses', 0x0A8, false, 8, 'ESC', 20, ['ADAS', 'EPS'], [['Pulse_FL', 10, 0, 1, 0, 0, 1023, '', 'counter'], ['Pulse_FR', 10, 0, 1, 0, 0, 1023, '', 'counter'], ['Pulse_RL', 10, 0, 1, 0, 0, 1023, '', 'counter'], ['Pulse_RR', 10, 0, 1, 0, 0, 1023, '', 'counter'], ['DirFwd', 1, 0, 1, 0, 0, 1, '', 'const:1']]],
  ['ADAS_Lanes', 0x168, false, 8, 'ADAS', 50, ['IPC', 'EPS'], [['LeftLaneDist', 12, 1, 0.01, 0, -20.48, 20.47, 'm', 'sine:15:0.3:-1.8'], ['RightLaneDist', 12, 1, 0.01, 0, -20.48, 20.47, 'm', 'sine:15:0.3:1.8'], ['LaneQuality', 4, 0, 1, 0, 0, 15, '', 'const:3'], ['HeadingErr', 16, 1, 0.0001, 0, -3.2768, 3.2767, 'rad', 'sine:15:0.01:0']]],
  ['BCM_Switches', 0x2C0, false, 8, 'BCM', 50, ['IPC', 'HVAC', 'GW'], [['WiperMode', 3, 0, 1, 0, 0, 7, '', 'const:1'], ['HornReq', 1, 0, 1, 0, 0, 1, '', 'const:0'], ['HazardSw', 1, 0, 1, 0, 0, 1, '', 'const:0'], ['SteerWheelBtns', 16, 0, 1, 0, 0, 65535, '', 'const:0'], ['DimmerLevel', 8, 0, 1, 0, 0, 255, '', 'const:180']]],
  ['IPC_Warnings', 0x3B0, false, 8, 'IPC', 200, ['GW'], [['WarnBitfield', 32, 0, 1, 0, 0, 4294967295, '', 'const:0'], ['ServiceDays', 12, 0, 1, 0, 0, 4095, 'd', 'const:212']]],
  ['ESC_ParkBrakeCmd', 0x5A0, false, 8, 'ESC', 20, ['BCM', 'IPC'], [['EPB_Request', 2, 0, 1, 0, 0, 3, '', 'const:0'], ['EPB_Force', 12, 0, 0.01, 0, 0, 40.95, 'kN', 'const:0'], ['EPB_Counter', 4, 0, 1, 0, 0, 15, '', 'counter']]],
];
// Deadlines: shorter than period for safety-critical messages (demonstrates constrained deadlines)
// ESC_ParkBrakeCmd: PLANTED PRIORITY ERROR — 4 ms deadline on a low-priority identifier (0x5A0).
const DEADLINES = { ESC_ParkBrakeCmd: 4, SRS_Status: 5, ESC_WheelSpeeds: 5, ESC_Dynamics: 5, EPS_Steering: 5, ADAS_Request: 10, ECM_Engine1: 10 };
const JITTER = { ESC_WheelSpeeds: 0.5, ESC_Dynamics: 0.5, ECM_Engine1: 1, TCM_Status: 1, ADAS_Request: 2, ADAS_Objects: 3, BCM_Lights: 5, HVAC_Status: 5, IPC_Display: 2 };

function layout(msg) {
  // Pack signals sequentially. Intel: start = LSB position; Motorola: start = MSB position (sawtooth)
  let bit = 0;
  return msg[7].map((s) => {
    const [name, len, signed, factor, offset, min, max, unit, wave, order] = s;
    let start;
    if (order === 'motorola') {
      // align to byte boundary for clarity; MSB at bit 7 of byte b
      if (bit % 8) bit += 8 - (bit % 8);
      const b = bit >> 3;
      start = b * 8 + 7;
      bit = b * 8 + Math.ceil(len / 8) * 8; // Motorola occupies whole bytes from the MSB downwards
    } else { start = bit; bit += len; }
    if (bit > msg[3] * 8) throw new Error(`layout overflow in ${msg[0]}`);
    return { name, length: len, signed: !!signed, factor, offset, min, max, unit, wave, start, byteOrder: order === 'motorola' ? 'motorola' : 'intel' };
  });
}

function writeDBC() {
  const L = [];
  L.push('VERSION "CANProof synthetic demo vehicle 1.0"', '', 'NS_ :', '', 'BS_:', '', 'BU_: ' + NODES.join(' '), '');
  const sigs = {};
  for (const m of MSGS) {
    const raw = m[2] ? (m[1] + 0x80000000) >>> 0 : m[1];
    sigs[m[0]] = layout(m);
    L.push(`BO_ ${raw} ${m[0]}: ${m[3]} ${m[4]}`);
    for (const s of sigs[m[0]]) {
      L.push(` SG_ ${s.name} : ${s.start}|${s.length}@${s.byteOrder === 'intel' ? 1 : 0}${s.signed ? '-' : '+'} (${s.factor},${s.offset}) [${s.min}|${s.max}] "${s.unit}" ${m[6].join(',')}`);
    }
    L.push('');
  }
  // A deliberately faulty message, labelled, so the layout checker has something real to find
  L.push('BO_ 1360 DIAG_Planted_Error: 2 GW');
  L.push(' SG_ PlantedA : 0|12@1+ (1,0) [0|4095] "" IPC');
  L.push(' SG_ PlantedB : 8|12@1+ (1,0) [0|4095] "" IPC');
  L.push('');
  L.push('CM_ "SYNTHETIC demo network generated by canproof/tools/make_synthetic.js. Not a real vehicle.";');
  L.push('CM_ BO_ 1440 "PLANTED PRIORITY ERROR for demonstration: 4 ms deadline on low-priority ID 0x5A0.";');
  L.push('CM_ BO_ 1360 "PLANTED ERROR for demonstration: signals overlap and run past the 2-byte payload.";');
  L.push('BA_DEF_ BO_ "GenMsgCycleTime" INT 0 65535;');
  L.push('BA_DEF_ BO_ "GenMsgDeadline" INT 0 65535;');
  L.push('BA_DEF_ BO_ "GenMsgJitter" FLOAT 0 1000;');
  L.push('BA_DEF_ BO_ "GenMsgSendType" ENUM "Cyclic","Event";');
  L.push('BA_DEF_DEF_ "GenMsgCycleTime" 0;');
  L.push('BA_DEF_DEF_ "GenMsgSendType" "Cyclic";');
  for (const m of MSGS) {
    const raw = m[2] ? (m[1] + 0x80000000) >>> 0 : m[1];
    L.push(`BA_ "GenMsgCycleTime" BO_ ${raw} ${m[5]};`);
    if (DEADLINES[m[0]] != null) L.push(`BA_ "GenMsgDeadline" BO_ ${raw} ${DEADLINES[m[0]]};`);
    if (JITTER[m[0]] != null) L.push(`BA_ "GenMsgJitter" BO_ ${raw} ${JITTER[m[0]]};`);
  }
  L.push('BA_ "GenMsgCycleTime" BO_ 1360 1000;');
  L.push('VAL_ 208 GearActual 0 "P" 1 "R" 2 "N" 3 "D1" 4 "D2" 5 "D3" 6 "D4" ;');
  L.push('VAL_ 1024 PowerMode 0 "Off" 1 "Acc" 2 "Run" 3 "Crank" 4 "Drive" ;');
  L.push('');
  return { text: L.join('\n'), sigs };
}

function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function main() {
  const out = path.join(__dirname, '..', 'data', 'synthetic');
  fs.mkdirSync(out, { recursive: true });
  const { text } = writeDBC();
  fs.writeFileSync(path.join(out, 'demo_vehicle.dbc'), text);
  const dbc = C.parseDBC(text);
  const set = C.messageSetFromDBC(dbc);
  const rnd = mulberry(2026);
  const state = {};
  const payload = (msg, k) => {
    const dm = dbc.messages.find((x) => (x.extended ? 'x' : 's') + x.id === msg.key);
    const data = new Uint8Array(dm.dlc);
    const t = k * msg.Tms / 1000;
    const def = MSGS.find((m) => m[0] === dm.name);
    dm.signals.forEach((s, i) => {
      const wave = def ? def[7][i][8] : 'walk:3';
      const [kind, a, b, c] = wave.split(':');
      const st = (state[dm.name + s.name] = state[dm.name + s.name] || { v: c != null ? Number(c) : Number(b || 0) });
      let v;
      if (kind === 'counter') v = k % (Math.pow(2, s.length));
      else if (kind === 'sine') v = Number(c) + Number(b) * Math.sin(2 * Math.PI * t / Number(a)) + Number(b) * 0.03 * (rnd() - 0.5);
      else if (kind === 'walk') { st.v += Number(a) * (rnd() - 0.5) * 2; v = st.v; }
      else if (kind === 'const') v = Number(a);
      else if (kind === 'enum') v = Math.floor((t / 3) % Number(a));
      else v = 0;
      C.encodeSignal(s, data, v);
    });
    return data;
  };
  const cache = new Map();
  const getPayload = (m, k) => { const key = m.key + ':' + k; if (!cache.has(key)) cache.set(key, payload(m, k)); return cache.get(key); };
  const offsets = {};
  for (const m of set) offsets[m.key] = Math.floor(rnd() * Math.min(m.Tms, 20) * 1e6);
  const DUR_S = 30;
  const sim = C.simulate(set, {
    bitrate: BITRATE, duration: DUR_S * 1e9, offsets, jitterMode: 'random', seed: 7,
    lengthMode: (m, k) => C.exactFrameBits(m.id, m.extended, getPayload(m, k)),
  });
  const epoch = 1700000000;
  const lines = ['# SYNTHETIC trace — generated by canproof/tools/make_synthetic.js from demo_vehicle.dbc with the CANProof simulator.', '# 500 kbit/s, 30 s, random release jitter within GenMsgJitter. NOT MEASURED DATA.'];
  for (const f of sim.frames) {
    const m = set.find((x) => x.key === f.key);
    const data = getPayload(m, f.k);
    const idStr = m.extended ? m.id.toString(16).toUpperCase().padStart(8, '0') : m.id.toString(16).toUpperCase().padStart(3, '0');
    const ts = (epoch + Math.round(f.end / 1000) / 1e6).toFixed(6); // timestamp at end of frame, 1 us resolution
    lines.push(`(${ts}) vcan0 ${idStr}#${Array.from(data, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join('')}`);
  }
  fs.writeFileSync(path.join(out, 'demo_vehicle.log'), lines.join('\n') + '\n');
  console.log(`wrote ${set.length} messages, ${sim.frames.length} frames (${DUR_S}s) to ${out}`);
}
if (require.main === module) main();
module.exports = { MSGS, BITRATE };
