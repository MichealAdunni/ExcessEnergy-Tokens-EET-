;; contracts/EnergyOracle.clar
(define-constant CONTRACT-OWNER tx-sender)
(define-constant ERR-NOT-AUTHORIZED u100)
(define-constant ERR-INVALID-PROOF u101)
(define-constant ERR-PROOF-EXPIRED u103)
(define-constant ERR-PROOF-TOO-EARLY u104)
(define-constant ERR-ORACLE-NOT-AUTHORIZED u106)
(define-constant ERR-PROOF-ALREADY-EXISTS u107)
(define-constant ERR-INVALID-SIGNATURE u108)
(define-constant ERR-INVALID-EXCESS-AMOUNT u110)
(define-constant ERR-PROOF-REVOKED u115)
(define-constant ERR-ORACLE-INACTIVE u116)

(define-data-var oracle-nonce uint u0)
(define-data-var min-quorum uint u3)
(define-data-var max-proof-age uint u720)

(define-map oracles principal
  {
    active: bool,
    stake: uint,
    last-submission: uint,
    success-count: uint,
    failure-count: uint,
    joined-at: uint
  }
)

(define-map producer-proofs
  { producer: principal, block: uint }
  {
    excess-kwh: uint,
    timestamp: uint,
    submitters: (list 10 principal),
    signatures: (list 10 (buff 65)),
    hash-chain: (buff 32),
    revoked: bool
  }
)

(define-map proof-index uint { producer: principal, block: uint })
(define-map oracle-submissions { oracle: principal, proof-id: uint } { submitted-at: uint })

(define-read-only (get-oracle (operator principal))
  (map-get? oracles operator)
)

(define-read-only (get-proof (producer principal) (block uint))
  (map-get? producer-proofs { producer: producer, block: block })
)

(define-read-only (get-proof-by-id (proof-id uint))
  (match (map-get? proof-index proof-id)
    idx (map-get? producer-proofs idx)
    none
  )
)

(define-read-only (is-oracle-active (operator principal))
  (default-to false (get active (map-get? oracles operator)))
)

(define-read-only (get-quorum-requirement)
  (var-get min-quorum)
)

(define-read-only (validate-proof-age (proof-block uint))
  (let ((age (- block-height proof-block)))
    (and (>= age u1) (<= age (var-get max-proof-age)))
  )
)

(define-read-only (hash-proof-data (producer principal) (block uint) (excess-kwh uint) (timestamp uint))
  (sha256
    (concat
      (concat (to-consensus-buff? producer) (to-consensus-buff? block))
      (concat (to-consensus-buff? excess-kwh) (to-consensus-buff? timestamp))
    )
  )
)

(define-private (verify-signature (message-hash (buff 32)) (signature (buff 65)) (pubkey principal))
  (is-eq (secp256k1-recover? message-hash signature) (some pubkey))
)

(define-private (check-oracle-quorum (submitters (list 10 principal)))
  (let ((active-count
          (fold
            (lambda (oracle acc)
              (if (is-oracle-active oracle) (+ acc u1) acc))
            submitters
            u0
          )))
    (>= active-count (var-get min-quorum))
  )
)

(define-public (register-oracle (stake uint))
  (let ((operator tx-sender)
        (existing (map-get? oracles operator)))
    (asserts! (is-none existing) (err ERR-NOT-AUTHORIZED))
    (asserts! (>= stake u1000000) (err ERR-INVALID-PROOF))
    (map-set oracles operator
      {
        active: true,
        stake: stake,
        last-submission: u0,
        success-count: u0,
        failure-count: u0,
        joined-at: block-height
      }
    )
    (ok true)
  )
)

(define-public (deregister-oracle)
  (let ((operator tx-sender)
        (oracle (unwrap! (map-get? oracles operator) (err ERR-ORACLE-NOT-AUTHORIZED))))
    (asserts! (get active oracle) (err ERR-ORACLE-INACTIVE))
    (map-set oracles operator (merge oracle { active: false }))
    (ok true)
  )
)

(define-public (submit-proof
  (producer principal)
  (block uint)
  (excess-kwh uint)
  (timestamp uint)
  (signature (buff 65))
)
  (let ((oracle tx-sender)
        (proof-id (var-get oracle-nonce))
        (existing-proof (map-get? producer-proofs { producer: producer, block: block }))
        (message-hash (hash-proof-data producer block excess-kwh timestamp))
        (oracle-data (unwrap! (map-get? oracles oracle) (err ERR-ORACLE-NOT-AUTHORIZED))))
    (asserts! (get active oracle-data) (err ERR-ORACLE-INACTIVE))
    (asserts! (is-none existing-proof) (err ERR-PROOF-ALREADY-EXISTS))
    (asserts! (> excess-kwh u0) (err ERR-INVALID-EXCESS-AMOUNT))
    (asserts! (validate-proof-age block) (err ERR-PROOF-EXPIRED))
    (asserts! (>= timestamp (* block u600)) (err ERR-PROOF-TOO-EARLY))
    (asserts! (verify-signature message-hash signature producer) (err ERR-INVALID-SIGNATURE))
    (let ((new-proof
            {
              excess-kwh: excess-kwh,
              timestamp: timestamp,
              submitters: (list oracle),
              signatures: (list signature),
              hash-chain: message-hash,
              revoked: false
            }))
      (map-set producer-proofs { producer: producer, block: block } new-proof)
      (map-set proof-index proof-id { producer: producer, block: block })
      (map-set oracle-submissions { oracle: oracle, proof-id: proof-id } { submitted-at: block-height })
      (var-set oracle-nonce (+ proof-id u1))
      (map-set oracles oracle
        (merge oracle-data {
          last-submission: block-height,
          success-count: (+ (get success-count oracle-data) u1)
        })
      )
      (ok proof-id)
    )
  )
)

(define-public (confirm-proof (proof-id uint) (signature (buff 65)))
  (let ((index (unwrap! (map-get? proof-index proof-id) (err ERR-INVALID-PROOF)))
        (proof (unwrap! (map-get? producer-proofs index) (err ERR-INVALID-PROOF)))
        (oracle tx-sender)
        (oracle-data (unwrap! (map-get? oracles oracle) (err ERR-ORACLE-NOT-AUTHORIZED)))
        (message-hash (get hash-chain proof)))
    (asserts! (get active oracle-data) (err ERR-ORACLE-INACTIVE))
    (asserts! (not (get revoked proof)) (err ERR-PROOF-REVOKED))
    (asserts! (is-none (index-of (get submitters proof) oracle)) (err ERR-PROOF-ALREADY-EXISTS))
    (asserts! (verify-signature message-hash signature (get producer index)) (err ERR-INVALID-SIGNATURE))
    (let ((updated-submitters (unwrap! (as-max-len? (append (get submitters proof) oracle) u10) (err ERR-INVALID-PROOF)))
          (updated-signatures (unwrap! (as-max-len? (append (get signatures proof) signature) u10) (err ERR-INVALID-PROOF))))
      (map-set producer-proofs index
        (merge proof {
          submitters: updated-submitters,
          signatures: updated-signatures
        })
      )
      (map-set oracle-submissions { oracle: oracle, proof-id: proof-id } { submitted-at: block-height })
      (map-set oracles oracle
        (merge oracle-data {
          last-submission: block-height,
          success-count: (+ (get success-count oracle-data) u1)
        })
      )
      (ok true)
    )
  )
)

(define-public (revoke-proof (producer principal) (block uint))
  (let ((proof-key { producer: producer, block: block })
        (proof (unwrap! (map-get? producer-proofs proof-key) (err ERR-INVALID-PROOF)))
        (caller tx-sender))
    (asserts!
      (or
        (is-eq caller CONTRACT-OWNER)
        (is-eq caller producer)
        (and (is-oracle-active caller) (> (get failure-count (unwrap! (map-get? oracles caller) (err ERR-ORACLE-NOT-AUTHORIZED))) u5))
      )
      (err ERR-NOT-AUTHORIZED)
    )
    (map-set producer-proofs proof-key (merge proof { revoked: true }))
    (ok true)
  )
)

(define-public (set-quorum (new-quorum uint))
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) (err ERR-NOT-AUTHORIZED))
    (asserts! (and (> new-quorum u0) (<= new-quorum u10)) (err ERR-INVALID-PROOF))
    (var-set min-quorum new-quorum)
    (ok true)
  )
)

(define-read-only (is-proof-confirmed (producer principal) (block uint))
  (match (map-get? producer-proofs { producer: producer, block: block })
    proof (and (not (get revoked proof)) (check-oracle-quorum (get submitters proof)))
    false
  )
)

(define-read-only (get-confirmed-excess (producer principal) (start-block uint) (end-block uint))
  (fold
    (lambda (b acc)
      (if (is-proof-confirmed producer b)
        (+ acc (default-to u0 (get excess-kwh (map-get? producer-proofs { producer: producer, block: b }))))
        acc
      )
    )
    (list start-block (+ start-block u1) (+ start-block u2) (+ start-block u3) (+ start-block u4))
    u0
  )
)