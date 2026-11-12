import { useState } from 'react'

const RENEW_URL = 'https://tldraw.dev/get-a-license/hobby'
const WARN_DAYS = 30
const SNOOZE_KEY = 'canvas-tutor-license-snooze'

/** The key's payload is base64url JSON: [id, hosts, flags, "YYYY-MM-DD" expiry]. */
function licenseExpiry(key: string | undefined): Date | null {
  if (!key) return null
  try {
    const payload = key.split('/')[1].split('.')[0].replace(/-/g, '+').replace(/_/g, '/')
    const data = JSON.parse(atob(payload + '='.repeat((4 - (payload.length % 4)) % 4)))
    const d = new Date(`${data[3]}T23:59:59Z`)
    return isNaN(d.getTime()) ? null : d
  } catch {
    return null
  }
}

export function LicenseNotice({ licenseKey }: { licenseKey: string | undefined }) {
  const [snoozed, setSnoozed] = useState(() => {
    try {
      return Number(localStorage.getItem(SNOOZE_KEY) ?? 0) > Date.now()
    } catch {
      return false
    }
  })
  if (import.meta.env.DEV || snoozed) return null
  const expiry = licenseExpiry(licenseKey)
  if (!expiry) return null
  const daysLeft = Math.ceil((expiry.getTime() - Date.now()) / 86_400_000)
  if (daysLeft > WARN_DAYS) return null
  const expired = daysLeft <= 0
  const date = expiry.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })

  return (
    <div className={`license-notice ${expired ? 'expired' : ''}`}>
      <strong>{expired ? `The canvas license expired on ${date}.` : `The canvas license expires on ${date} (${daysLeft} day${daysLeft === 1 ? '' : 's'}).`}</strong>
      <ol>
        <li>
          Get a new free hobby key at{' '}
          <a href={RENEW_URL} target="_blank" rel="noreferrer">
            tldraw.dev/get-a-license/hobby
          </a>{' '}
          (domain: <code>{location.hostname}</code>).
        </li>
        <li>
          On your PC, replace <code>VITE_TLDRAW_LICENSE_KEY</code> in the project's <code>.env</code> with the new key.
        </li>
        <li>
          Run <code>bash deploy/deploy.sh</code> (or ask Claude Code to redeploy).
        </li>
      </ol>
      {!expired && (
        <button
          onClick={() => {
            try {
              localStorage.setItem(SNOOZE_KEY, String(Date.now() + 3 * 86_400_000))
            } catch {}
            setSnoozed(true)
          }}
        >
          Remind me in 3 days
        </button>
      )}
    </div>
  )
}
