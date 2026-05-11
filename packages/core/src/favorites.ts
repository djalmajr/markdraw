import * as v from "valibot";
import { FavoriteFileSchema, type FavoriteFile, safeJsonParse, tryParse } from "./schemas.ts";

const STORAGE_KEY = "asciimark-favorites";

function readFavorites(): FavoriteFile[] {
  const list = safeJsonParse(localStorage.getItem(STORAGE_KEY), v.array(v.unknown()));
  if (!list) return [];
  const out: FavoriteFile[] = [];
  for (const item of list) {
    const fav = tryParse(FavoriteFileSchema, item);
    if (fav) out.push(fav);
  }
  return out;
}

function getFavorites(): FavoriteFile[] {
  return readFavorites();
}

function addFavorite(file: FavoriteFile): FavoriteFile[] {
  const validated = v.parse(FavoriteFileSchema, file);
  const favorites = readFavorites().filter(
    (f) => !(f.path === validated.path && f.rootPath === validated.rootPath),
  );
  favorites.unshift(validated);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites));
  return favorites;
}

function removeFavorite(path: string, rootPath: string): FavoriteFile[] {
  const favorites = readFavorites().filter(
    (f) => !(f.path === path && f.rootPath === rootPath),
  );
  localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites));
  return favorites;
}

function isFavorite(
  path: string,
  rootPath: string,
  favorites: FavoriteFile[],
): boolean {
  return favorites.some((f) => f.path === path && f.rootPath === rootPath);
}

export {
  type FavoriteFile,
  addFavorite,
  getFavorites,
  isFavorite,
  removeFavorite,
};
