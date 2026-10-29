// Bank lines for the same shop rarely repeat word for word: card numbers,
// references and dates change each time ("COMPRA 4521 CONTINENTE 27/10").
// The key keeps only the words, so those lines still count as the same.

/** "COMPRA 4521 Continente-Lisboa 27/10" -> "compra continente lisboa". */
export function descriptionKey(description: string): string {
  return description
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !/\d/.test(w))
    .join(" ");
}
