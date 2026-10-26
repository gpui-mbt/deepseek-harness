/** CSS module class maps emitted into the browser bundle. */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
