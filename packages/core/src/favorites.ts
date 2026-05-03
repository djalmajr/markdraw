import * as v from "valibot";
import { FavoriteFileSchema, type FavoriteFile, tryParse } from "./schemas.ts";

const STORAGE_KEY = "asciimark-favorites";

function readFavorites(): FavoriteFile[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    const out: FavoriteFile[] = [];
    for (const item of parsed) {
      const fav = tryParse(FavoriteFileSchema, item);
      if (fav) out.push(fav);
    }
    return out;
  } catch {
    return [];
  }
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
