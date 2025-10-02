;; token-minter.clar

(use-trait oracle-trait .energy-oracle-trait.oracle-trait)
(use-trait registry-trait .producer-registry-trait.registry-trait)

(impl-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-10-ft-standard.ft-trait)

(define-constant ERR-NOT-REGISTERED u200)
(define-constant ERR-INSUFFICIENT-PROOF u201)
(define-constant ERR-INVALID-AMOUNT u202)
(define-constant ERR-MAX-SUPPLY-REACHED u203)
(define-constant ERR-NOT-AUTHORIZED u204)
(define-constant ERR-PROOF-EXPIRED u205)
(define-constant ERR-ALREADY-MINTED u206)
(define-constant ERR-INVALID-PROOF-ID u207)
(define-constant ERR-BURN-FAILED u208)
(define-constant ERR-TRANSFER-FAILED u209)
(define-constant ERR-PAUSED u210)
(define-constant ERR-INVALID-RECIPIENT u211)
(define-constant ERR-ZERO-AMOUNT u212)
(define-constant ERR-INVALID-TIMESTAMP u213)
(define-constant ERR-MINT-LIMIT-EXCEEDED u214)
(define-constant ERR-INVALID-ORACLE u215)
(define-constant ERR-INVALID-REGISTRY u216)
(define-constant ERR-INVALID-DECIMALS u217)
(define-constant ERR-INVALID-SUPPLY u218)
(define-constant ERR-INVALID-FEE u219)
(define-constant ERR-FEE-TRANSFER-FAILED u220)

(define-constant MAX-SUPPLY u1000000000000)
(define-constant MINT-FEE-PERCENT u1)
(define-constant PROOF-EXPIRY u144)
(define-constant MAX-MINT-PER-PROOF u1000000)
(define-constant TOKEN-DECIMALS u6)

(define-fungible-token eet-token MAX-SUPPLY)

(define-data-var contract-owner principal tx-sender)
(define-data-var paused bool false)
(define-data-var total-minted uint u0)
(define-data-var oracle-contract principal .energy-oracle)
(define-data-var registry-contract principal .producer-registry)
(define-data-var mint-fee-recipient principal tx-sender)

(define-map minted-proofs uint { minted-amount: uint, timestamp: uint })
(define-map user-mint-history principal (list 100 uint))

(define-read-only (get-balance (account principal))
  (ft-get-balance eet-token account)
)

(define-read-only (get-total-supply)
  (ft-get-supply eet-token)
)

(define-read-only (get-name)
  (ok "ExcessEnergyToken")
)

(define-read-only (get-symbol)
  (ok "EET")
)

(define-read-only (get-decimals)
  (ok TOKEN-DECIMALS)
)

(define-read-only (get-token-uri)
  (ok (some u"https://example.com/eet-metadata.json"))
)

(define-read-only (get-mintable-amount (proof-id uint))
  (let ((proof (unwrap! (contract-call? .energy-oracle get-proof proof-id) (err ERR-INVALID-PROOF-ID)))
        (minted (default-to { minted-amount: u0, timestamp: u0 } (map-get? minted-proofs proof-id))))
    (if (>= (get excess-kwh proof) (get minted-amount minted))
        (ok (- (get excess-kwh proof) (get minted-amount minted)))
        (ok u0)))
)

(define-read-only (is-proof-minted (proof-id uint))
  (is-some (map-get? minted-proofs proof-id))
)

(define-read-only (get-minted-proof (proof-id uint))
  (map-get? minted-proofs proof-id)
)

(define-read-only (get-user-mint-history (user principal))
  (map-get? user-mint-history user)
)

(define-read-only (is-paused)
  (var-get paused)
)

(define-read-only (get-contract-owner)
  (var-get contract-owner)
)

(define-private (is-owner)
  (is-eq tx-sender (var-get contract-owner))
)

(define-private (calculate-fee (amount uint))
  (/ (* amount MINT-FEE-PERCENT) u100)
)

(define-private (validate-proof (proof { excess-kwh: uint, timestamp: uint, producer: principal }) (amount uint))
  (and
    (is-eq (get producer proof) tx-sender)
    (>= (get excess-kwh proof) amount)
    (<= (- block-height (get timestamp proof)) PROOF-EXPIRY)
    (> amount u0)
    (<= amount MAX-MINT-PER-PROOF)
  )
)

(define-private (update-minted-proof (proof-id uint) (amount uint) (existing { minted-amount: uint, timestamp: uint }))
  (map-set minted-proofs proof-id { minted-amount: (+ (get minted-amount existing) amount), timestamp: block-height })
)

(define-private (append-to-history (user principal) (proof-id uint))
  (map-set user-mint-history user (append (default-to (list) (map-get? user-mint-history user)) proof-id))
)

(define-public (mint-tokens (amount uint) (proof-id uint))
  (let ((proof (unwrap! (contract-call? .energy-oracle get-proof proof-id) (err ERR-INVALID-PROOF-ID)))
        (minted (default-to { minted-amount: u0, timestamp: u0 } (map-get? minted-proofs proof-id)))
        (fee (calculate-fee amount))
        (net-amount (- amount fee)))
    (asserts! (not (var-get paused)) (err ERR-PAUSED))
    (asserts! (contract-call? .producer-registry is-registered? tx-sender) (err ERR-NOT-REGISTERED))
    (asserts! (validate-proof proof net-amount) (err ERR-INSUFFICIENT-PROOF))
    (asserts! (<= (+ (var-get total-minted) amount) MAX-SUPPLY) (err ERR-MAX-SUPPLY-REACHED))
    (try! (ft-mint? eet-token net-amount tx-sender))
    (try! (stx-transfer? fee tx-sender (var-get mint-fee-recipient)))
    (update-minted-proof proof-id net-amount minted)
    (append-to-history tx-sender proof-id)
    (var-set total-minted (+ (var-get total-minted) net-amount))
    (print { event: "mint", amount: net-amount, fee: fee, proof-id: proof-id, minter: tx-sender })
    (ok net-amount))
)

(define-public (burn-tokens (amount uint))
  (asserts! (> amount u0) (err ERR-ZERO-AMOUNT))
  (try! (ft-burn? eet-token amount tx-sender))
  (print { event: "burn", amount: amount, burner: tx-sender })
  (ok amount)
)

(define-public (transfer (amount uint) (sender principal) (recipient principal))
  (asserts! (is-eq tx-sender sender) (err ERR-NOT-AUTHORIZED))
  (asserts! (> amount u0) (err ERR-ZERO-AMOUNT))
  (asserts! (not (is-eq recipient sender)) (err ERR-INVALID-RECIPIENT))
  (try! (ft-transfer? eet-token amount sender recipient))
  (print { event: "transfer", amount: amount, from: sender, to: recipient })
  (ok true)
)

(define-public (pause-contract)
  (begin
    (asserts! (is-owner) (err ERR-NOT-AUTHORIZED))
    (var-set paused true)
    (ok true))
)

(define-public (unpause-contract)
  (begin
    (asserts! (is-owner) (err ERR-NOT-AUTHORIZED))
    (var-set paused false)
    (ok true))
)

(define-public (set-mint-fee-recipient (new-recipient principal))
  (begin
    (asserts! (is-owner) (err ERR-NOT-AUTHORIZED))
    (var-set mint-fee-recipient new-recipient)
    (ok true))
)

(define-public (set-oracle-contract (new-oracle principal))
  (begin
    (asserts! (is-owner) (err ERR-NOT-AUTHORIZED))
    (var-set oracle-contract new-oracle)
    (ok true))
)

(define-public (set-registry-contract (new-registry principal))
  (begin
    (asserts! (is-owner) (err ERR-NOT-AUTHORIZED))
    (var-set registry-contract new-registry)
    (ok true))
)

(define-public (transfer-ownership (new-owner principal))
  (begin
    (asserts! (is-owner) (err ERR-NOT-AUTHORIZED))
    (asserts! (not (is-eq new-owner tx-sender)) (err ERR-INVALID-RECIPIENT))
    (var-set contract-owner new-owner)
    (ok true))
)