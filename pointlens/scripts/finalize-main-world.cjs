const fs = require("node:fs")
const path = require("node:path")

// Plasmo 0.90's manifest validator predates static MAIN-world declarations.
// Let Parcel bundle the entries, then add Chrome's supported world field.
// Plasmo runs this hook after both production builds and dev rebuilds.
module.exports = () => {
  const option = (name) => {
    const index = process.argv.indexOf(name)
    return index < 0 ? undefined : process.argv[index + 1]
  }
  const target = option("--target") || process.env.PLASMO_TARGET || "chrome-mv3"
  const tag =
    option("--tag") ||
    process.env.PLASMO_TAG ||
    (process.argv.includes("dev") ? "dev" : "prod")
  const directory = process.env.PLASMO_BUILD_DIR || path.resolve("build")
  const filename = path.join(directory, `${target}-${tag}`, "manifest.json")
  const manifest = JSON.parse(fs.readFileSync(filename, "utf8"))
  for (const brand of ["hyatt", "ihg", "marriott"]) {
    const entries = manifest.content_scripts.filter(
      (entry) =>
        entry.matches?.includes(`https://www.${brand}.com/*`) &&
        entry.js?.some((file) => /^content-main\.[\w]+\.js$/.test(file))
    )
    if (entries.length !== 1)
      throw Error(`Expected one ${brand} MAIN-world entry`)
    entries[0].world = "MAIN"
  }
  fs.writeFileSync(filename, JSON.stringify(manifest))
}
