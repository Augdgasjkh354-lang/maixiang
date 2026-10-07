export function nextRandom(state) {
  const seed = (Math.imul(state.rng.state, 1664525) + 1013904223) >>> 0;
  state.rng.state = seed;
  return seed / 4294967296;
}

export function binomial(state, count, probability) {
  let successes = 0;
  for (let i = 0; i < count; i += 1) {
    if (nextRandom(state) < probability) successes += 1;
  }
  return successes;
}
