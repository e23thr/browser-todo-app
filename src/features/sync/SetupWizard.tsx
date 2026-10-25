/**
 * Opt-in sync setup wizard (E8 S9) — two steps: the storage address, then the
 * sign-in details with the connection test.
 *
 * Contract (docs/dev/sync-engine-api.md §6): NOTHING touches the network before
 * the user submits the test. `probe()` only runs after `configure()`, so the
 * submit path is configure → probe, and a failed probe ROLLS BACK via
 * `forgetCredentials()` — setup completes only when the connection is verified,
 * so the app is never left half-configured. The insecure-URL check runs locally
 * (`assertSecureRemote`) and never reaches the network either.
 *
 * A11y (WCAG 2.2 AA): one form per step (Enter submits natively), focus moves
 * to the first field of the new step, the progress list carries
 * `aria-current="step"`, and step changes + outcomes go through `announce()`.
 * The password field is masked and never leaves the form unencoded — the engine
 * stores it per the contract (browser profile `sync_state`, or memory only).
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX, TargetedEvent } from 'preact';

import { announce } from '../../app/announce';
import { t } from '../../app/i18n';
import { assertSecureRemote } from '../../sync';
import { syncErrorCopy } from './errorCopy';
import { SyncErrorBox } from './SyncErrorBox';
import type { SyncHostEngine } from './syncHost';

interface SetupFailure {
  readonly title: string;
  readonly body?: string;
  readonly detail?: string;
}

export interface SetupWizardProps {
  readonly engine: SyncHostEngine;
  /** Prefill for the re-entry flow ("Enter credentials again"). */
  readonly initial?: { readonly remoteUrl: string; readonly remoteUser: string };
  /** The panel keeps this wizard mounted while a submit is in flight. */
  readonly onStart: () => void;
  /** Called when the submit settles (success or rolled-back failure). */
  readonly onEnd: () => void;
}

type Step = 1 | 2;

const TOTAL_STEPS = 2;

export function SetupWizard({ engine, initial, onStart, onEnd }: SetupWizardProps): JSX.Element {
  const [step, setStep] = useState<Step>(1);
  const [remoteUrl, setRemoteUrl] = useState(initial?.remoteUrl ?? '');
  const [user, setUser] = useState(initial?.remoteUser ?? '');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<SetupFailure | null>(null);

  const urlRef = useRef<HTMLInputElement>(null);
  const userRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const stepped = useRef(false);

  const titleOf = (target: Step): string =>
    target === 1 ? t('sync.wizard.step.url') : t('sync.wizard.step.credentials');

  // Focus follows the current step — but the FIRST render never steals focus
  // (the route-change contract owns initial focus).
  useEffect(() => {
    if (!stepped.current) {
      stepped.current = true;
      return;
    }
    (step === 1 ? urlRef.current : userRef.current)?.focus();
  }, [step]);

  const goTo = (target: Step): void => {
    setStep(target);
    announce(
      t('sync.wizard.stepAnnounce', {
        step: String(target),
        total: String(TOTAL_STEPS),
        title: titleOf(target),
      }),
    );
  };

  const submitStep1 = (event: TargetedEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const invalid = assertSecureRemote(remoteUrl.trim());
    if (invalid !== null) {
      // Local refusal — zero network (the opt-in boundary holds even for errors).
      const copy = syncErrorCopy(invalid);
      setFailure(copy);
      // SyncErrorBox renders no role="alert" (it would double-speak), so the
      // message has to reach assistive tech through the global live region.
      announce(t('a11y.sync.failed', { message: copy.title }), 'assertive');
      return;
    }
    setFailure(null);
    goTo(2);
  };

  const submitStep2 = (event: TargetedEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy) return;
    if (password === '') {
      const copy = { title: t('sync.password.required') };
      setFailure(copy);
      announce(t('a11y.sync.failed', { message: copy.title }), 'assertive');
      passwordRef.current?.focus();
      return;
    }
    setFailure(null);
    onStart();
    setBusy(true);
    void (async () => {
      const configured = await engine.configure({
        remoteUrl: remoteUrl.trim(),
        user,
        password,
        remember,
      });
      if (!configured.ok) {
        const copy = syncErrorCopy(configured.error);
        await engine.forgetCredentials(); // roll back — setup never half-completes
        setFailure(copy);
        announce(t('a11y.sync.failed', { message: copy.title }), 'assertive');
        setBusy(false);
        onEnd();
        return;
      }
      const probed = await engine.probe();
      if (!probed.ok) {
        const copy = syncErrorCopy(probed.error);
        await engine.forgetCredentials();
        setFailure(copy);
        announce(t('a11y.sync.failed', { message: copy.title }), 'assertive');
        setBusy(false);
        onEnd();
        return;
      }
      announce(t('a11y.sync.enabled'));
      setBusy(false);
      onEnd();
    })();
  };

  const failureBox =
    failure === null ? null : (
      <SyncErrorBox testId="setup-error" title={failure.title} {...failureDetail(failure)} />
    );

  return (
    <div class="sync-wizard-wrap">
      <h3 class="sync-wizard-heading">{titleOf(step)}</h3>
      <ol class="sync-steps" aria-label={t('sync.wizard.progressLabel')}>
        <li aria-current={step === 1 ? 'step' : undefined}>{t('sync.wizard.step.url')}</li>
        <li aria-current={step === 2 ? 'step' : undefined}>{t('sync.wizard.step.credentials')}</li>
      </ol>

      {step === 1 ? (
        <form class="sync-wizard" data-testid="sync-wizard" onSubmit={submitStep1}>
          {failureBox}
          <div class="field">
            <label class="field-label" for="sync-url">
              {t('sync.url.label')}
            </label>
            <input
              ref={urlRef}
              class="input"
              id="sync-url"
              type="url"
              inputMode="url"
              autocomplete="url"
              spellcheck={false}
              value={remoteUrl}
              aria-describedby="sync-url-hint"
              onInput={(event) => {
                setRemoteUrl(event.currentTarget.value);
              }}
            />
            <p class="field-hint" id="sync-url-hint">
              {t('sync.url.hint')}
            </p>
          </div>
          <div class="sync-actions">
            <button type="submit" class="button button-primary">
              {t('sync.wizard.next')}
            </button>
          </div>
        </form>
      ) : (
        <form class="sync-wizard" data-testid="sync-wizard" onSubmit={submitStep2}>
          {failureBox}
          <div class="field">
            <label class="field-label" for="sync-user">
              {t('sync.user.label')}
            </label>
            <input
              ref={userRef}
              class="input"
              id="sync-user"
              type="text"
              autocomplete="username"
              value={user}
              onInput={(event) => {
                setUser(event.currentTarget.value);
              }}
            />
          </div>
          <div class="field">
            <label class="field-label" for="sync-password">
              {t('sync.password.label')}
            </label>
            <input
              ref={passwordRef}
              class="input"
              id="sync-password"
              type="password"
              autocomplete="current-password"
              value={password}
              onInput={(event) => {
                setPassword(event.currentTarget.value);
              }}
            />
          </div>
          <div class="field">
            <label class="checkbox-row" for="sync-remember">
              <input
                id="sync-remember"
                type="checkbox"
                checked={remember}
                onChange={(event) => {
                  setRemember(event.currentTarget.checked);
                }}
              />
              <span>{t('sync.remember.label')}</span>
            </label>
            <p class="field-hint">{t('sync.remember.hint')}</p>
          </div>
          <div class="sync-actions">
            <button
              type="button"
              class="button button-secondary"
              disabled={busy}
              onClick={() => {
                setFailure(null);
                goTo(1);
              }}
            >
              {t('sync.wizard.back')}
            </button>
            <button type="submit" class="button button-primary" disabled={busy}>
              {busy ? t('sync.wizard.testing') : t('sync.wizard.submit')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/** Spread helper so the optional body/detail only pass through when present. */
function failureDetail(failure: SetupFailure): { body?: string; detail?: string } {
  return {
    ...(failure.body === undefined ? {} : { body: failure.body }),
    ...(failure.detail === undefined ? {} : { detail: failure.detail }),
  };
}
