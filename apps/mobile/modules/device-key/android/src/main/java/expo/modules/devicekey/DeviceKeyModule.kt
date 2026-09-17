package expo.modules.devicekey

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.Base64

/**
 * Device binding, the Android half (ai/phase-14-mobile.md §4.5).
 *
 * ⚠ UNVERIFIED — see `modules/device-key/index.ts`'s own header. This file
 * has never been compiled in this session; `apps/mobile`'s toolchain has no
 * Kotlin/Android compiler. Written against the documented Android Keystore
 * API as closely as this session could manage. Things worth checking first
 * against a real build/run, in order of how likely they are to be the
 * actual bug if something is wrong:
 *
 *   1. `setIsStrongBoxBacked` is API 28+ — guarded on `Build.VERSION.SDK_INT`
 *      here so the METHOD is never even called on an older OS build (a
 *      `try/catch` around `StrongBoxUnavailableException` alone only covers
 *      "this specific device has no StrongBox chip", not "this OS build
 *      predates the method existing at all").
 *   2. `ECPublicKey.w.affineX`/`affineY` are `BigInteger`s, and
 *      `BigInteger.toByteArray()` is variable-length and can carry a
 *      leading zero sign byte — `toFixedLength` below is what normalizes
 *      that to the exact 32 bytes the server's `P256_COORDINATE_BYTES`
 *      check expects; get that normalization wrong and every signature
 *      still verifies fine while every REGISTRATION silently sends a
 *      malformed key.
 *   3. `"SHA256withECDSA"` is expected to emit a standard ASN.1 DER
 *      signature (JCA's default for EC), matching iOS's
 *      `.ecdsaSignatureMessageX962SHA256` and the server's `dsaEncoding:
 *      'der'` — if the underlying provider on a given device ever encoded
 *      IEEE P1363 instead, verification would fail with no error message
 *      more specific than "invalid signature".
 */
class DeviceKeyModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DeviceKey")

    AsyncFunction("getPublicKey") {
      val entry = loadEntry() ?: return@AsyncFunction null
      coordinates(entry.certificate.publicKey as ECPublicKey)
    }

    AsyncFunction("generateKey") {
      coordinates(generateKeyPair())
    }

    AsyncFunction("sign") { data: String ->
      val entry = loadEntry() ?: throw DeviceKeyNoKeyException()
      val signature = Signature.getInstance("SHA256withECDSA")
      signature.initSign(entry.privateKey)
      signature.update(data.toByteArray(Charsets.UTF_8))
      Base64.getEncoder().encodeToString(signature.sign())
    }
  }

  companion object {
    /**
     * The Keystore alias the private key is stored under — scoped to this
     * app's own Keystore namespace implicitly (entries are already
     * per-application on Android), so a literal string is enough; this app
     * has exactly one device key, ever.
     */
    private const val KEY_ALIAS = "com.rinavai.app.devicekey"
    private const val KEYSTORE_PROVIDER = "AndroidKeyStore"

    private fun keyStore(): KeyStore {
      val store = KeyStore.getInstance(KEYSTORE_PROVIDER)
      store.load(null)
      return store
    }

    private fun loadEntry(): KeyStore.PrivateKeyEntry? {
      val store = keyStore()
      if (!store.containsAlias(KEY_ALIAS)) return null
      return store.getEntry(KEY_ALIAS, null) as? KeyStore.PrivateKeyEntry
    }

    /**
     * Generates a NEW key, replacing any that already exists under the same
     * alias — the JS side's `ensurePublicKey()` already checks for an
     * existing key first, so reaching this means a fresh one was wanted.
     *
     * StrongBox (a discrete secure element, stronger isolation than the
     * TEE-backed default) is preferred when the device has one; most
     * devices do not, so the fallback path is the common case, not an edge
     * case — both are still hardware-isolated from this app's own process.
     */
    private fun generateKeyPair(): ECPublicKey {
      val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE_PROVIDER)

      fun specBuilder() =
        KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_SIGN)
          .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
          .setDigests(KeyProperties.DIGEST_SHA256)
          // Not gated on biometric/passcode confirmation per signature —
          // device binding proves POSSESSION of the device; biometric
          // app-lock is a separate Wave 1b item that will gate the app's
          // own UI independently, not this key.
          .setUserAuthenticationRequired(false)

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        try {
          generator.initialize(specBuilder().setIsStrongBoxBacked(true).build())
          return generator.generateKeyPair().public as ECPublicKey
        } catch (e: StrongBoxUnavailableException) {
          // This specific device has no StrongBox chip — fall through to
          // the TEE-backed default below.
        }
      }

      generator.initialize(specBuilder().build())
      return generator.generateKeyPair().public as ECPublicKey
    }

    /** P-256's field size. Every coordinate is normalized to exactly this many bytes. */
    private const val FIELD_SIZE_BYTES = 32

    private fun coordinates(publicKey: ECPublicKey): Map<String, String> {
      val x = toFixedLength(publicKey.w.affineX.toByteArray(), FIELD_SIZE_BYTES)
      val y = toFixedLength(publicKey.w.affineY.toByteArray(), FIELD_SIZE_BYTES)
      return mapOf(
        "x" to base64UrlEncode(x),
        "y" to base64UrlEncode(y),
      )
    }

    /** See this class's own header, point 2, for why this normalization exists at all. */
    private fun toFixedLength(bytes: ByteArray, length: Int): ByteArray =
      when {
        bytes.size == length -> bytes
        bytes.size == length + 1 && bytes[0] == 0.toByte() -> bytes.copyOfRange(1, bytes.size)
        bytes.size < length -> ByteArray(length - bytes.size) + bytes
        else -> bytes.copyOfRange(bytes.size - length, bytes.size)
      }

    private fun base64UrlEncode(bytes: ByteArray): String =
      Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
  }
}

class DeviceKeyNoKeyException :
  expo.modules.kotlin.exception.CodedException("No device key has been generated yet.")
