# Unicode & i18n

## Emoji ZWJ sequences

Family: 👨‍👩‍👧‍👦 Person facepalming: 🤦‍♀️
Pirate flag (joiner sequence): 🏴‍☠️
Skin-tone modifier on hand: 👋🏽

## CJK (full-width)

中文测试：你好，世界。
日本語テスト：こんにちは、世界。
한국어 테스트: 안녕하세요, 세계.

## RTL inline (Arabic + Hebrew)

This sentence has Arabic مرحبا بالعالم inside.
Hebrew sample: שלום עולם — surrounded by LTR.

## Combining diacriticals

NFC vs NFD: café (single é = U+00E9) vs café (e + U+0301).
Vietnamese: tiếng Việt.

## Surrogate pairs in fences

```text
math: 𝐇𝐞𝐥𝐥𝐨 (Mathematical Bold Latin Capital H = U+1D407)
emoji: 🚀 → 🚀
```

## Greek + math

α + β = γ. Σ from i=1 to n of i².

## Right-to-left override (security smell — should NOT bypass escapes)

Filename‮gnp.exe trailing override marker.
