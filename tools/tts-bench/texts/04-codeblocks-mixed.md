The playback timeout can be adjusted by reading the WAV duration and applying a safety margin.

```ts
function wavPlaybackTimeoutMs(wavBuffer: Buffer): number | undefined {
  if (wavBuffer.length < 44) return undefined;
  const byteRate = wavBuffer.readUInt32LE(28);
  const dataSize = wavBuffer.readUInt32LE(40);
  return Math.ceil(Math.max(30_000, (dataSize / byteRate) * 1000 + 15_000));
}
```

This kind of response should be paraphrased for speech rather than read as punctuation and syntax.
