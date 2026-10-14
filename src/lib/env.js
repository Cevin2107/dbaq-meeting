/** Access to the puter.js global, with a friendly failure mode. */

export function hasPuter() {
  return typeof window !== 'undefined' && !!window.puter;
}

export function getPuter() {
  if (!hasPuter()) {
    throw new Error(
      'Puter.js is not loaded. Check your connection to https://js.puter.com/v2/ and reload the page.'
    );
  }
  return window.puter;
}
