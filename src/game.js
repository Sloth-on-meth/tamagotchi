// Bitling — a pocket virtual pet.
(function () {
  'use strict';

  const W = 32, H = 16;            // LCD resolution in dots
  const MIN = 60000;               // one simulated minute in ms
  const DAY = 1440;                // minutes per day
  const SAVE_KEY = 'bitling.save.v1';
  const PREF_KEY = 'bitling.prefs.v1';
  const SP = window.BITLING_SPRITES;
  const ICONS = window.BITLING_ICONS;
  const FONT = window.BITLING_FONT;

  // ---------------------------------------------------------------- species
  // hungerEvery / happyEvery / poopEvery are in minutes. bed = [sleep hour, wake hour].
  const SPECIES = {
    egg:      { name: 'Egg',      stage: 'egg',   baseWeight: 5 },
    blip:     { name: 'Blip',     stage: 'baby',  baseWeight: 5,  hungerEvery: 5,  happyEvery: 6,  poopEvery: 15,  bed: null },
    puddo:    { name: 'Puddo',    stage: 'child', baseWeight: 10, hungerEvery: 20, happyEvery: 18, poopEvery: 60,  bed: [20, 9] },
    sprout:   { name: 'Sprout',   stage: 'teen',  baseWeight: 20, hungerEvery: 32, happyEvery: 30, poopEvery: 80,  bed: [21, 9] },
    grub:     { name: 'Grub',     stage: 'teen',  baseWeight: 20, hungerEvery: 25, happyEvery: 22, poopEvery: 70,  bed: [21, 9] },
    starling: { name: 'Starling', stage: 'adult', baseWeight: 25, hungerEvery: 55, happyEvery: 50, poopEvery: 110, bed: [22, 8], lifespan: 18 },
    glimmer:  { name: 'Glimmer',  stage: 'adult', baseWeight: 25, hungerEvery: 45, happyEvery: 40, poopEvery: 100, bed: [22, 9], lifespan: 14 },
    lumpkin:  { name: 'Lumpkin',  stage: 'adult', baseWeight: 30, hungerEvery: 35, happyEvery: 32, poopEvery: 90,  bed: [21, 9], lifespan: 10 },
    mopey:    { name: 'Mopey',    stage: 'adult', baseWeight: 30, hungerEvery: 28, happyEvery: 25, poopEvery: 80,  bed: [20, 9], lifespan: 7 },
  };
  // How long each stage lasts, in minutes.
  const STAGE_LEN = { egg: 1, baby: 60, child: DAY, teen: 2 * DAY };

  const ACTIONS = ['food', 'light', 'play', 'medicine', 'clean', 'status', 'discipline'];
  const ICON_ORDER = ['food', 'light', 'play', 'medicine', 'clean', 'status', 'discipline', 'attention'];

  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function load(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  }
  function store(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* storage unavailable */ }
  }

  // ---------------------------------------------------------------- state
  const prefs = Object.assign({ speed: 1, sound: true, shell: 'coral' }, load(PREF_KEY) || {});

  function newPet(gen) {
    const now = Date.now();
    return {
      v: 1, gen: gen || 1, species: 'egg', stageMin: 0, ageMin: 0,
      hunger: 0, happy: 0, discipline: 0, weight: 5,
      poops: 0, poopTimer: 10, hungerTimer: 0, happyTimer: 0,
      sick: false, sickMin: 0, doses: 0,
      asleep: false, lights: true,
      call: false, callMin: 0, callCounted: false,
      discCall: false, discCallMin: 0,
      starveMin: 0, snackStreak: 0,
      mistakes: 0, stageMistakes: 0, discMisses: 0,
      dead: false, cause: null,
      petTime: now, lastReal: now, acc: 0,
    };
  }

  let pet = load(SAVE_KEY);
  if (!pet || pet.v !== 1 || !SPECIES[pet.species]) pet = newPet(1);

  const save = () => store(SAVE_KEY, pet);
  const savePrefs = () => store(PREF_KEY, prefs);
  const spec = () => SPECIES[pet.species];
  const years = () => Math.floor(pet.ageMin / DAY);

  // ---------------------------------------------------------------- simulation
  function needsCare(p) {
    if (p.dead || p.species === 'egg') return false;
    return p.asleep ? p.lights : (p.hunger === 0 || p.happy === 0);
  }

  function refreshCall(p) {
    if (!needsCare(p)) p.call = false;
  }

  function makeSick(p, ev) {
    if (p.sick) return;
    p.sick = true;
    p.sickMin = 0;
    p.doses = Math.random() < 0.5 ? 1 : 2;
    ev.push('sick');
  }

  function die(p, cause, ev) {
    p.dead = true;
    p.cause = cause;
    p.call = p.discCall = p.asleep = false;
    p.lights = true;
    ev.push('die');
  }

  function becomeSpecies(p, id) {
    const sp = SPECIES[id];
    p.species = id;
    p.stageMin = 0;
    p.stageMistakes = 0;
    p.weight = Math.max(p.weight, sp.baseWeight);
    p.poopTimer = Math.round(sp.poopEvery * rand(0.7, 1.3));
    p.hungerTimer = p.happyTimer = 0;
  }

  function evolve(p, ev) {
    const stage = SPECIES[p.species].stage;
    let next;
    if (stage === 'baby') next = 'puddo';
    else if (stage === 'child') next = p.stageMistakes <= 2 ? 'sprout' : 'grub';
    else {
      const m = p.stageMistakes, good = p.species === 'sprout';
      if (good && m <= 1 && p.discipline >= 75) next = 'starling';
      else if (good && m <= 3) next = 'glimmer';
      else if (m <= 5) next = 'lumpkin';
      else next = 'mopey';
    }
    becomeSpecies(p, next);
    ev.push('evolve');
  }

  function inBed(hour, bed) {
    if (!bed) return false;
    return bed[0] > bed[1] ? (hour >= bed[0] || hour < bed[1]) : (hour >= bed[0] && hour < bed[1]);
  }

  // Advance the pet by one simulated minute.
  function stepMinute(p, ev) {
    p.petTime += MIN;
    if (p.dead) return;

    if (p.species === 'egg') {
      if (++p.stageMin >= STAGE_LEN.egg) {
        becomeSpecies(p, 'blip');
        ev.push('hatch');
      }
      return;
    }

    const sp = SPECIES[p.species];
    p.ageMin++;
    p.stageMin++;

    const bedtime = inBed(new Date(p.petTime).getHours(), sp.bed);
    if (bedtime && !p.asleep) { p.asleep = true; p.discCall = false; ev.push('sleep'); }
    else if (!bedtime && p.asleep) { p.asleep = false; p.lights = true; ev.push('wake'); }

    if (!p.asleep) {
      const f = p.sick ? 0.6 : 1;
      if (++p.hungerTimer >= sp.hungerEvery * f) { p.hungerTimer = 0; if (p.hunger > 0) p.hunger--; }
      if (++p.happyTimer >= sp.happyEvery * f) { p.happyTimer = 0; if (p.happy > 0) p.happy--; }
      if (--p.poopTimer <= 0) {
        p.poopTimer = Math.round(sp.poopEvery * rand(0.7, 1.3));
        if (p.poops < 4) { p.poops++; ev.push('poop'); }
      }
      p.starveMin = p.hunger === 0 ? p.starveMin + 1 : 0;
      if ((sp.stage === 'child' || sp.stage === 'teen') && !p.discCall &&
          p.hunger > 0 && p.happy > 0 && Math.random() < 1 / 150) {
        p.discCall = true;
        p.discCallMin = 0;
        ev.push('misbehave');
      }
    }

    if (p.discCall && ++p.discCallMin >= 15) { p.discCall = false; p.discMisses++; }

    if (!p.sick) {
      const chance = p.poops * 0.0015 + (p.weight > sp.baseWeight + 20 ? 0.002 : 0);
      if (Math.random() < chance) makeSick(p, ev);
    } else if (++p.sickMin >= 12 * 60) {
      return die(p, 'illness', ev);
    }
    if (p.starveMin >= 12 * 60) return die(p, 'hunger', ev);

    if (needsCare(p)) {
      if (!p.call) { p.call = true; p.callMin = 0; p.callCounted = false; ev.push('call'); }
      else if (++p.callMin >= 15 && !p.callCounted) {
        p.callCounted = true;
        p.mistakes++;
        p.stageMistakes++;
      }
    } else {
      p.call = false;
    }

    if (!p.asleep && STAGE_LEN[sp.stage] && p.stageMin >= STAGE_LEN[sp.stage]) {
      evolve(p, ev);
    } else if (sp.stage === 'adult' && !p.asleep &&
               p.ageMin / DAY >= Math.max(3, sp.lifespan - Math.floor(p.mistakes / 3))) {
      die(p, 'old age', ev);
    }
  }

  function simulate() {
    const now = Date.now();
    const gap = Math.max(0, now - pet.lastReal);
    pet.lastReal = now;
    // Time spent away (closed tab, sleeping laptop) always passes at normal speed.
    const speed = gap > 5000 ? 1 : prefs.speed;
    pet.acc += gap * speed;
    let steps = Math.floor(pet.acc / MIN);
    pet.acc -= steps * MIN;
    if (steps > 14 * DAY) { steps = 14 * DAY; pet.acc = 0; }
    if (!steps) return;
    const ev = [];
    for (let i = 0; i < steps && !pet.dead; i++) stepMinute(pet, ev);
    handleEvents(ev, steps > 3);
    save();
  }

  // ---------------------------------------------------------------- sound
  let actx = null;
  function tone(freq, dur, delay) {
    if (!prefs.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const t = actx.currentTime + (delay || 0);
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'square';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.04, t);
      g.gain.setValueAtTime(0, t + dur);
      o.connect(g).connect(actx.destination);
      o.start(t);
      o.stop(t + dur + 0.02);
    } catch (e) { /* audio unavailable */ }
  }
  const sfx = {
    press: () => tone(2400, 0.03),
    call: () => { tone(2000, 0.08); tone(2000, 0.08, 0.16); tone(2000, 0.08, 0.32); },
    no: () => { tone(400, 0.09); tone(300, 0.12, 0.11); },
    yes: () => { tone(1500, 0.06); tone(2200, 0.08, 0.08); },
    jingle: () => [1300, 1600, 2000, 2600].forEach((f, i) => tone(f, 0.08, i * 0.1)),
  };

  // ---------------------------------------------------------------- messages
  const msgEl = document.getElementById('msg');
  function say(text) { msgEl.textContent = text; }

  function callReason() {
    if (pet.asleep && pet.lights) return 'It fell asleep. Turn off the light!';
    if (pet.hunger === 0) return 'It is hungry!';
    if (pet.happy === 0) return 'It is bored and wants to play!';
    return 'It needs you!';
  }

  function handleEvents(ev, batch) {
    if (!ev.length) return;
    const has = (e) => ev.includes(e);
    if (has('die')) {
      ui.mode = 'dead'; ui.anim = null; ui.sel = -1;
      say(`Your Bitling has passed away (${pet.cause}). Press B to start a new egg.`);
      sfx.no();
      return;
    }
    if (has('hatch')) {
      say('Your Bitling hatched! It is hungry and wants to play.');
      if (!batch && ui.mode === 'main') playAnim('hatch', 6);
      sfx.jingle();
    }
    if (has('evolve')) {
      say(`Your Bitling grew into a ${spec().name}!`);
      if (!batch && ui.mode === 'main') playAnim('evolve', 6);
      sfx.jingle();
    }
    if (has('sick')) say('It got sick! Give it medicine.');
    else if (has('call')) { say(callReason()); sfx.call(); }
    else if (has('misbehave')) { say('It is misbehaving… a little discipline might help.'); sfx.call(); }
    else if (has('poop') && !has('hatch') && !has('evolve')) say('It pooped. Time to clean up!');
    else if (has('wake')) say('Good morning!');
    else if (has('sleep')) say('It fell asleep.');
  }

  // ---------------------------------------------------------------- UI state
  const ui = {
    mode: pet.dead ? 'dead' : 'main', // main | food | status | clock | game | dead
    sel: -1, tick: 0, petX: 8, dir: 1,
    anim: null, menu: 0, page: 0, game: null,
  };

  function playAnim(type, len, data) {
    ui.anim = Object.assign({ type, len, start: ui.tick }, data || {});
  }

  function petSprite() { return SP[pet.species]; }

  function poopMaxX(w) {
    const n = pet.poops;
    return (n === 0 ? W : n <= 2 ? 25 : 19) - w;
  }

  function blockedAction() {
    if (pet.dead) return true;
    if (pet.species === 'egg') { sfx.no(); say('The egg is still hatching…'); return true; }
    if (pet.asleep) { sfx.no(); say('Shh… it is sleeping.'); return true; }
    return false;
  }

  function refuse() {
    sfx.no();
    playAnim('refuse', 4);
  }

  // ---------------------------------------------------------------- actions
  function activate(action) {
    switch (action) {
      case 'food':
        if (blockedAction()) return;
        ui.mode = 'food'; ui.menu = 0;
        break;
      case 'light':
        if (pet.dead) return;
        pet.lights = !pet.lights;
        refreshCall(pet);
        say(pet.lights ? 'Lights on.' : 'Lights off.');
        sfx.press();
        break;
      case 'play':
        if (blockedAction()) return;
        if (pet.sick) { say('It is too sick to play.'); return refuse(); }
        ui.mode = 'game';
        ui.game = { round: 0, wins: 0, phase: 'guess', t: ui.tick, guess: 0, dir: 0 };
        say('Which way will it go? A = left, B = right.');
        break;
      case 'medicine':
        if (blockedAction()) return;
        if (!pet.sick) { say('It is not sick.'); return refuse(); }
        playAnim('medicine', 5);
        if (--pet.doses <= 0) {
          pet.sick = false; pet.sickMin = 0;
          say('All better!');
        } else {
          say('One more dose needed.');
        }
        sfx.yes();
        break;
      case 'clean':
        if (blockedAction()) return;
        playAnim('clean', 6, { poops: pet.poops, after: pet.poops > 0 ? 'happy' : null });
        if (pet.poops) say('Squeaky clean!');
        pet.poops = 0;
        sfx.press();
        break;
      case 'status':
        ui.mode = 'status'; ui.page = 0;
        break;
      case 'discipline':
        if (blockedAction()) return;
        if (pet.discCall) {
          pet.discCall = false;
          pet.discipline = Math.min(100, pet.discipline + 25);
          say('It will behave now.');
        } else {
          pet.happy = Math.max(0, pet.happy - 1);
          say('It did nothing wrong… now it is sad.');
        }
        playAnim('scold', 4);
        sfx.no();
        break;
    }
    save();
  }

  function feed(kind) {
    ui.mode = 'main';
    if (kind === 'meal') {
      if (pet.hunger >= 4) { say('It is full!'); return refuse(); }
      pet.hunger++;
      pet.weight++;
      pet.snackStreak = 0;
      pet.starveMin = 0;
    } else {
      pet.happy = Math.min(4, pet.happy + 1);
      pet.weight += 2;
      if (++pet.snackStreak >= 5 && Math.random() < 0.5) {
        const ev = [];
        makeSick(pet, ev);
        if (ev.length) say('Too many snacks! It got sick.');
      }
    }
    refreshCall(pet);
    if (!pet.sick) say(kind === 'meal' ? 'Yum!' : 'A tasty treat!');
    playAnim('eat', 6, { food: kind });
    sfx.yes();
    save();
  }

  function finishGame() {
    const g = ui.game;
    pet.weight = Math.max(spec().baseWeight, pet.weight - 1);
    if (g.wins >= 3) {
      pet.happy = Math.min(4, pet.happy + 1);
      refreshCall(pet);
      say(`It won ${g.wins} of 5! Happier and a little fitter.`);
      sfx.jingle();
    } else {
      say(`Only ${g.wins} of 5. Good exercise though!`);
    }
    save();
  }

  // ---------------------------------------------------------------- input
  function press(btn) {
    sfx.press();
    if (ui.mode === 'dead') {
      if (btn === 'B') {
        pet = newPet((pet.gen || 1) + 1);
        ui.mode = 'main'; ui.sel = -1;
        say('A new egg! Keep it company while it hatches.');
        save();
      }
      return render();
    }
    if (ui.anim) return; // wait for animation

    switch (ui.mode) {
      case 'main':
        if (btn === 'A') ui.sel = (ui.sel + 1) % ACTIONS.length;
        else if (btn === 'B') {
          if (ui.sel >= 0) activate(ACTIONS[ui.sel]);
          else ui.mode = 'clock';
        } else if (btn === 'C') ui.sel = -1;
        break;
      case 'clock':
        ui.mode = 'main';
        break;
      case 'food':
        if (btn === 'A') ui.menu = (ui.menu + 1) % 2;
        else if (btn === 'B') feed(ui.menu === 0 ? 'meal' : 'snack');
        else ui.mode = 'main';
        break;
      case 'status':
        if (btn === 'C') ui.mode = 'main';
        else ui.page = (ui.page + 1) % 5;
        break;
      case 'game': {
        const g = ui.game;
        if (btn === 'C') { ui.mode = 'main'; ui.game = null; say('Maybe later.'); break; }
        if (g.phase === 'guess') {
          g.guess = btn === 'A' ? -1 : 1;
          g.dir = Math.random() < 0.5 ? -1 : 1;
          g.phase = 'reveal';
          g.t = ui.tick;
          if (g.guess === g.dir) { g.wins++; sfx.yes(); } else sfx.no();
        } else if (g.phase === 'result') {
          ui.mode = 'main'; ui.game = null;
        }
        break;
      }
    }
    render();
  }

  // ---------------------------------------------------------------- clock tick (animations)
  function tick() {
    ui.tick++;
    const a = ui.anim;
    if (a && ui.tick - a.start >= a.len) {
      ui.anim = null;
      if (a.after) playAnim(a.after, 4);
    }

    if (ui.mode === 'game') {
      const g = ui.game;
      if (g.phase === 'reveal' && ui.tick - g.t >= 3) {
        if (++g.round >= 5) { g.phase = 'result'; g.t = ui.tick; finishGame(); }
        else { g.phase = 'guess'; g.t = ui.tick; }
      } else if (g.phase === 'result' && ui.tick - g.t >= 6) {
        ui.mode = 'main'; ui.game = null;
      }
    }

    // wander around
    if (ui.mode === 'main' && !ui.anim && !pet.dead && !pet.asleep && pet.species !== 'egg') {
      const w = petSprite().w;
      const maxX = Math.max(0, poopMaxX(w));
      if (Math.random() < 0.2) ui.dir = -ui.dir;
      if (Math.random() < 0.6) ui.petX += ui.dir * 2;
      if (ui.petX <= 0) { ui.petX = 0; ui.dir = 1; }
      if (ui.petX >= maxX) { ui.petX = maxX; ui.dir = -1; }
    }
    render();
  }

  // ---------------------------------------------------------------- framebuffer drawing
  const fb = new Uint8Array(W * H);
  const px = (x, y, v) => { if (x >= 0 && x < W && y >= 0 && y < H) fb[y * W + x] = v === undefined ? 1 : v; };

  function blit(s, x, y, opt) {
    const flip = opt && opt.flip, from = (opt && opt.from) || 0;
    for (let j = 0; j < s.h; j++) {
      for (let i = from; i < s.w; i++) {
        if (s.d[j * s.w + i]) px(flip ? x + s.w - 1 - i : x + i, y + j);
      }
    }
  }
  const textW = (str) => str.length * 4 - 1;
  function text(str, x, y) {
    for (const ch of String(str).toUpperCase()) {
      const g = FONT[ch];
      if (g) for (let j = 0; j < 5; j++) for (let i = 0; i < 3; i++) if (g[j][i] === '1') px(x + i, y + j);
      x += 4;
    }
  }
  const ctext = (str, y) => text(str, Math.floor((W - textW(str)) / 2), y);
  const rtext = (str, y) => text(str, W - textW(str), y);

  const POOP_POS = [[26, 11], [26, 5], [20, 11], [20, 5]];
  function drawPoops(n, maxX) {
    for (let i = 0; i < n; i++) {
      const [x, y] = POOP_POS[i];
      if (maxX === undefined || x < maxX) blit(SP.poop, x, y, { flip: ui.tick % 2 === 1 });
    }
  }

  function drawPet(x, bob, flip) {
    const s = petSprite();
    const lift = bob && s.h < H ? ui.tick % 2 : 0;
    blit(s, x, H - s.h - lift, { flip });
  }

  function drawMain() {
    if (ui.anim) return drawAnim();
    const s = petSprite();
    if (pet.species === 'egg') {
      const wob = [0, 1, 0, -1][ui.tick % 4];
      blit(s, ((W - s.w) >> 1) + wob, H - s.h);
      return false;
    }
    ui.petX = clamp(ui.petX, 0, Math.max(0, poopMaxX(s.w)));
    if (pet.asleep) {
      drawPet(ui.petX, false, false);
      const zx = ui.petX + s.w + 1 <= W - 3 ? ui.petX + s.w + 1 : Math.max(0, ui.petX - 4);
      text('Z', zx, ui.tick % 2 ? 0 : 2);
    } else {
      drawPet(ui.petX, true, ui.dir < 0);
    }
    drawPoops(pet.poops);
    if (pet.sick && ui.tick % 2 === 0) blit(SP.skull, W - 5, 0);
    return !pet.lights;
  }

  function drawAnim() {
    const a = ui.anim, e = ui.tick - a.start, s = petSprite();
    const centerX = (W - s.w) >> 1;
    switch (a.type) {
      case 'eat': {
        const food = SP[a.food];
        const bites = Math.min(3, Math.floor(e / 2));
        if (bites < 3) blit(food, 1, H - food.h, { from: Math.round((food.w * bites) / 3) });
        drawPet(W - s.w, true, true);
        break;
      }
      case 'refuse':
        drawPet(centerX + (e % 2 ? -2 : 2), false, e % 2 === 1);
        break;
      case 'clean': {
        const lineX = W - 1 - Math.round(((e + 1) * W) / a.len);
        drawPet(ui.petX, false, false);
        drawPoops(a.poops, lineX);
        for (let y = 0; y < H; y++) px(lineX, y);
        break;
      }
      case 'medicine':
        drawPet(W - s.w, false, false);
        blit(SP.syringe, Math.min(e * 3, W - s.w - 10), (H >> 1) - 1);
        break;
      case 'scold':
        drawPet(centerX + (e % 2 ? -1 : 1), false, false);
        if (e % 2 === 0) blit(SP.anger, 0, 0);
        break;
      case 'happy':
        drawPet(centerX, true, false);
        if (e % 2 === 0) { blit(SP.sparkle, 1, 1); blit(SP.sparkle, W - 4, 1); }
        else { blit(SP.sparkle, 3, 6); blit(SP.sparkle, W - 6, 6); }
        break;
      case 'hatch': {
        const egg = e < 3 ? SP.egg : SP.eggCrack;
        if (e < 5) blit(egg, ((W - egg.w) >> 1) + (e % 2 ? 1 : -1), H - egg.h);
        else drawPet(centerX, false, false);
        return e === 4;
      }
      case 'evolve':
        drawPet(centerX, false, false);
        return e < 4 && e % 2 === 0;
    }
    return false;
  }

  function drawFood() {
    text(ui.menu === 0 ? '>' : ' ', 1, 2);
    text('MEAL', 6, 2);
    text(ui.menu === 1 ? '>' : ' ', 1, 9);
    text('SNACK', 6, 9);
  }

  function drawHearts(n) {
    for (let i = 0; i < 4; i++) blit(i < n ? SP.heart : SP.heartEmpty, i * 8, 9);
  }

  function drawStatus() {
    switch (ui.page) {
      case 0:
        text('AGE', 0, 2); rtext(`${years()}Y`, 2);
        text('WGT', 0, 9); rtext(`${pet.weight}G`, 9);
        break;
      case 1: ctext('HUNGRY', 1); drawHearts(pet.hunger); break;
      case 2: ctext('HAPPY', 1); drawHearts(pet.happy); break;
      case 3: {
        ctext('DISCIP', 1);
        for (let x = 1; x < 31; x++) { px(x, 9); px(x, 14); }
        for (let y = 9; y < 15; y++) { px(1, y); px(30, y); }
        const fill = Math.round((28 * pet.discipline) / 100);
        for (let x = 2; x < 2 + fill; x++) for (let y = 11; y < 13; y++) px(x, y);
        break;
      }
      case 4:
        ctext(spec().name.toUpperCase().slice(0, 8), 2);
        ctext(`GEN ${pet.gen}`, 9);
        break;
    }
  }

  function drawClock() {
    const d = new Date(pet.petTime);
    const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
    ctext(ui.tick % 2 ? `${hh}:${mm}` : `${hh} ${mm}`, 5);
  }

  function drawGame() {
    const g = ui.game, s = petSprite(), cx = (W - s.w) >> 1;
    if (g.phase === 'guess') {
      drawPet(cx, true, false);
      if (ui.tick % 2) { text('<', 0, 5); text('>', W - 3, 5); }
      text(`${g.round + 1}`, 0, 0);
    } else if (g.phase === 'reveal') {
      const x = clamp(cx + g.dir * 6, 0, W - s.w);
      drawPet(x, false, g.dir < 0);
      if (g.guess === g.dir) {
        if (ui.tick % 2) { blit(SP.sparkle, g.dir < 0 ? W - 4 : 1, 1); }
      } else {
        blit(SP.anger, g.dir < 0 ? W - 5 : 0, 0);
      }
    } else {
      ctext(`${g.wins}/5`, 2);
      ctext(g.wins >= 3 ? 'WIN!' : 'LOSE', 9);
    }
  }

  function drawDead() {
    const t = ui.tick % 8;
    if (t < 5) {
      const y = 4 + (ui.tick % 2);
      blit(SP.halo, (W - SP.halo.w) >> 1, y - 4);
      blit(SP.ghost, (W - SP.ghost.w) >> 1, y);
    } else {
      ctext('R.I.P', 2);
      ctext('B:NEW', 9);
    }
  }

  // ---------------------------------------------------------------- painting
  const canvas = document.getElementById('lcd');
  const ctx = canvas.getContext('2d');
  const ON = '#1c2416', OFF = 'rgba(28,36,22,0.08)';

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(64, Math.round(canvas.getBoundingClientRect().width * dpr));
    canvas.width = w;
    canvas.height = Math.round(w / 2);
    render();
  }

  function paint() {
    const cw = canvas.width, cell = cw / W, gap = Math.max(1, cell * 0.14);
    ctx.clearRect(0, 0, cw, canvas.height);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        ctx.fillStyle = fb[y * W + x] ? ON : OFF;
        ctx.fillRect(x * cell + gap / 2, y * cell + gap / 2, cell - gap, cell - gap);
      }
    }
  }

  const iconEls = ICON_ORDER.map((name) => document.querySelector(`[data-icon="${name}"]`));
  function setupIcons() {
    ICON_ORDER.forEach((name, i) => {
      const c = iconEls[i].querySelector('canvas');
      const s = ICONS[name];
      c.width = s.w; c.height = s.h;
      const g = c.getContext('2d');
      g.fillStyle = ON;
      for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) if (s.d[y * s.w + x]) g.fillRect(x, y, 1, 1);
    });
  }
  function updateIcons() {
    ICON_ORDER.forEach((name, i) => {
      const on = name === 'attention'
        ? (pet.call || pet.discCall) && !pet.dead
        : ui.sel === i && ui.mode === 'main';
      iconEls[i].classList.toggle('on', !!on);
    });
  }

  function render() {
    fb.fill(0);
    let invert = false;
    switch (ui.mode) {
      case 'main': invert = drawMain(); break;
      case 'food': drawFood(); break;
      case 'status': drawStatus(); break;
      case 'clock': drawClock(); break;
      case 'game': drawGame(); break;
      case 'dead': drawDead(); break;
    }
    if (invert) for (let i = 0; i < fb.length; i++) fb[i] ^= 1;
    paint();
    updateIcons();
  }

  // ---------------------------------------------------------------- wiring
  document.querySelectorAll('[data-btn]').forEach((b) => {
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      b.classList.add('down');
      press(b.dataset.btn);
    });
    const up = () => b.classList.remove('down');
    b.addEventListener('pointerup', up);
    b.addEventListener('pointerleave', up);
    b.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); press(b.dataset.btn); }
    });
  });

  // Tapping an icon selects it; tapping the selected icon uses it.
  iconEls.forEach((el, i) => {
    if (ICON_ORDER[i] === 'attention') return;
    el.addEventListener('click', () => {
      if (ui.mode !== 'main' || ui.anim || pet.dead) return;
      sfx.press();
      if (ui.sel === i) activate(ACTIONS[i]);
      else ui.sel = i;
      render();
    });
  });

  const KEYS = { a: 'A', 1: 'A', s: 'B', 2: 'B', Enter: 'B', d: 'C', 3: 'C', Escape: 'C' };
  window.addEventListener('keydown', (e) => {
    if (e.target.closest && e.target.closest('button, input, select, summary')) return;
    let btn = KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (ui.mode === 'game') {
      if (e.key === 'ArrowLeft') btn = 'A';
      if (e.key === 'ArrowRight') btn = 'B';
    }
    if (!btn || e.repeat) return;
    e.preventDefault();
    press(btn);
  });

  // Settings panel
  const shell = document.getElementById('device');
  function applyPrefs() {
    shell.dataset.shell = prefs.shell;
    document.querySelectorAll('[data-speed]').forEach((b) =>
      b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === prefs.speed)));
    document.querySelectorAll('[data-shell]').forEach((b) => {
      if (b.tagName === 'BUTTON') b.setAttribute('aria-pressed', String(b.dataset.shell === prefs.shell));
    });
    document.getElementById('sound').checked = prefs.sound;
  }
  document.querySelectorAll('[data-speed]').forEach((b) => b.addEventListener('click', () => {
    simulate(); // settle time at the old speed first
    prefs.speed = Number(b.dataset.speed);
    savePrefs(); applyPrefs();
  }));
  document.querySelectorAll('button[data-shell]').forEach((b) => b.addEventListener('click', () => {
    prefs.shell = b.dataset.shell; savePrefs(); applyPrefs();
  }));
  document.getElementById('sound').addEventListener('change', (e) => {
    prefs.sound = e.target.checked; savePrefs();
  });
  document.getElementById('reset').addEventListener('click', () => {
    if (!confirm('Start over with a brand new egg? Your current Bitling will be lost.')) return;
    pet = newPet((pet.gen || 1) + (pet.species === 'egg' ? 0 : 1));
    ui.mode = 'main'; ui.sel = -1; ui.anim = null; ui.game = null;
    say('A new egg! Keep it company while it hatches.');
    save(); render();
  });

  document.addEventListener('visibilitychange', () => { simulate(); save(); });
  window.addEventListener('resize', resize);

  // ---------------------------------------------------------------- start
  setupIcons();
  applyPrefs();
  simulate();
  if (pet.dead) ui.mode = 'dead';
  else if (pet.species === 'egg') say('An egg! Keep it company while it hatches.');
  else if (pet.call) say(callReason());
  else say(`Welcome back! Your ${spec().name} missed you.`);
  resize();
  setInterval(simulate, 250);
  setInterval(tick, 500);

  // Small hook for debugging in the console.
  window.bitling = {
    get pet() { return pet; },
    skip(minutes) { const ev = []; for (let i = 0; i < minutes && !pet.dead; i++) stepMinute(pet, ev); handleEvents(ev, true); save(); render(); },
  };
})();
