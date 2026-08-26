/**
 * `ffprobe-static` ships no type definitions of its own. This is the whole of
 * its surface as far as BreadCrumbs is concerned — declared locally rather than
 * adding another dependency for four lines.
 */
declare module 'ffprobe-static' {
  const ffprobeStatic: { path: string };
  export default ffprobeStatic;
}
