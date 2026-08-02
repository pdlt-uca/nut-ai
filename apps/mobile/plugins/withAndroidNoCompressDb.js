const { withAppBuildGradle } = require('@expo/config-plugins')

/**
 * Ensures Android does not compress .db assets inside the APK.
 * Without this, expo-sqlite's importDatabaseFromAssetAsync silently
 * copies a corrupted/empty database on Android — same code works
 * fine on iOS, which has no such compression step.
 */
module.exports = function withAndroidNoCompressDb(config) {
  return withAppBuildGradle(config, (config) => {
    if (!config.modResults.contents.includes('noCompress')) {
      config.modResults.contents = config.modResults.contents.replace(
        /android\s*\{/,
        `android {\n    aaptOptions {\n        noCompress "db"\n    }`,
      )
    }
    return config
  })
}
