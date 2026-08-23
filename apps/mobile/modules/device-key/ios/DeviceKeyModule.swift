import ExpoModulesCore
import Security

/// Device binding, the iOS half (ai/phase-14-mobile.md §4.5).
///
/// ⚠ UNVERIFIED — see `modules/device-key/index.ts`'s own header. This file
/// has never been compiled in this session; `apps/mobile`'s toolchain has no
/// Swift compiler. It follows Apple's documented Security framework APIs as
/// closely as this session could manage. Things worth checking first against
/// a real build/run, in order of how likely they are to be the actual bug if
/// something is wrong:
///
///   1. `SecKeyCreateSignature`'s algorithm constant
///      (`.ecdsaSignatureMessageX962SHA256`) is a MESSAGE algorithm — it
///      hashes internally — not a digest algorithm; passing pre-hashed bytes
///      here would sign the wrong thing silently.
///   2. `SecKeyCopyExternalRepresentation` on the PUBLIC key returned by
///      `SecKeyCopyPublicKey` is the uncompressed ANSI X9.63 point
///      (`0x04 || X || Y`, 65 bytes for P-256) — the 65/0x04 check below is
///      what catches a format Apple ever changed this to.
///   3. `kSecAttrTokenIDSecureEnclave` requires exactly `kSecAttrKeyTypeEC-
///      SECPrimeRandom` at 256 bits; a mismatched type/size fails key
///      generation, not signing, so that failure surfaces at first sign-in.
///
/// A key generated with `kSecAttrTokenIDSecureEnclave` and `.privateKeyUsage`
/// in its access control can be used to sign but its PRIVATE representation
/// can never be exported — `SecKeyCopyExternalRepresentation` on the private
/// key itself would fail; only the derived public key is ever read out. That
/// is the entire security property this module exists to provide.
public class DeviceKeyModule: Module {
  public func definition() -> ModuleDefinition {
    Name("DeviceKey")

    AsyncFunction("getPublicKey") { () -> [String: String]? in
      guard let privateKey = try DeviceKeyModule.loadPrivateKey() else { return nil }
      guard let publicKey = SecKeyCopyPublicKey(privateKey) else {
        throw DeviceKeyError.keyGenerationFailed
      }
      return try DeviceKeyModule.coordinates(from: publicKey)
    }

    AsyncFunction("generateKey") { () -> [String: String] in
      let publicKey = try DeviceKeyModule.generateKeyPair()
      return try DeviceKeyModule.coordinates(from: publicKey)
    }

    AsyncFunction("sign") { (data: String) -> String in
      guard let privateKey = try DeviceKeyModule.loadPrivateKey() else {
        throw DeviceKeyError.noKey
      }
      guard let messageData = data.data(using: .utf8) else {
        throw DeviceKeyError.badInput
      }
      var signError: Unmanaged<CFError>?
      guard
        let signature = SecKeyCreateSignature(
          privateKey,
          .ecdsaSignatureMessageX962SHA256,
          messageData as CFData,
          &signError
        ) as Data?
      else {
        throw DeviceKeyError.signingFailed
      }
      return signature.base64EncodedString()
    }
  }

  /// The tag under which the private key is stored in the Keychain — scoped
  /// to this app's bundle id implicitly (Keychain items are already
  /// per-application on iOS), so a literal string is enough; no user or
  /// session id belongs in it; this app has exactly one device key, ever.
  private static let keyTag = "com.taskflow.app.devicekey".data(using: .utf8)!

  private static func loadPrivateKey() throws -> SecKey? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: keyTag,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecReturnRef as String: true,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw DeviceKeyError.keychainReadFailed }
    // swiftlint:disable:next force_cast
    return (item as! SecKey)
  }

  /// Generates a NEW Secure Enclave key, replacing any that already exists
  /// under the same tag — `SecKeyCreateRandomKey` with `kSecAttrIsPermanent`
  /// overwrites a prior item at the same tag rather than erroring, which is
  /// the correct behaviour here: `ensurePublicKey()` on the JS side already
  /// checks for an existing key first, so reaching this function at all
  /// means the caller decided a fresh key is what it wants.
  private static func generateKeyPair() throws -> SecKey {
    var accessError: Unmanaged<CFError>?
    guard
      let accessControl = SecAccessControlCreateWithFlags(
        kCFAllocatorDefault,
        // Usable once the device has been unlocked at least once since boot
        // — the same accessibility class `device-secure-store.ts` already
        // uses for the refresh token, so a push-woken background refresh
        // can still sign. `.privateKeyUsage` (not a biometric flag) is what
        // pins the key to the Secure Enclave; biometric gating is a
        // SEPARATE Wave 1b item (app-lock), not this one.
        kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        .privateKeyUsage,
        &accessError
      )
    else {
      throw DeviceKeyError.keyGenerationFailed
    }

    let attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
      kSecPrivateKeyAttrs as String: [
        kSecAttrIsPermanent as String: true,
        kSecAttrApplicationTag as String: keyTag,
        kSecAttrAccessControl as String: accessControl,
      ],
    ]

    var genError: Unmanaged<CFError>?
    guard let privateKey = SecKeyCreateRandomKey(attributes as CFDictionary, &genError) else {
      throw DeviceKeyError.keyGenerationFailed
    }
    guard let publicKey = SecKeyCopyPublicKey(privateKey) else {
      throw DeviceKeyError.keyGenerationFailed
    }
    return publicKey
  }

  /// The server (`packages/security/src/device-binding.ts`) expects the raw
  /// P-256 point as two 32-byte, base64url-encoded coordinates — see this
  /// class's own header for why 65/0x04 is the shape being asserted here.
  private static func coordinates(from publicKey: SecKey) throws -> [String: String] {
    var copyError: Unmanaged<CFError>?
    guard let raw = SecKeyCopyExternalRepresentation(publicKey, &copyError) as Data? else {
      throw DeviceKeyError.keyGenerationFailed
    }
    guard raw.count == 65, raw.first == 0x04 else {
      throw DeviceKeyError.unexpectedKeyFormat
    }
    let x = raw.subdata(in: 1..<33)
    let y = raw.subdata(in: 33..<65)
    return [
      "x": DeviceKeyModule.base64UrlEncode(x),
      "y": DeviceKeyModule.base64UrlEncode(y),
    ]
  }

  private static func base64UrlEncode(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}

enum DeviceKeyError: Error {
  case noKey
  case badInput
  case signingFailed
  case keyGenerationFailed
  case keychainReadFailed
  case unexpectedKeyFormat
}
