#pragma once
#import <Foundation/Foundation.h>

// Internal library only: Security.framework checks the embedding process's
// entitlement, not this library's signature. A trusted native broker must admit
// and authorize callers before invoking it. Never expose it as a generic CLI or
// unauthenticated IPC endpoint. The runtime CAS never bootstraps missing state.
FOUNDATION_EXPORT NSData * _Nullable DonaKeychainCasProcessRequest(NSData * _Nonnull input);

// Explicit local-operator provisioning only; never called during runtime recovery.
FOUNDATION_EXPORT NSData * _Nullable DonaKeychainProvisionRequest(NSData * _Nonnull input);
