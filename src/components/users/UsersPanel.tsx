'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { disableUser, enableUser, inviteUser, resetUserPassword } from '@/app/actions/admin';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { Field } from '@/components/ui/Field';
import { inviteUserSchema, type InviteUserInput } from '@/schemas/users';

export interface UserRow {
  userId: string;
  email: string | null;
  name: string;
  role: 'admin' | 'user';
  isActive: boolean;
  /** Display-ready (DD-MM-YYYY) or null. */
  invitedOn: string | null;
}

type Notice = { tone: 'good' | 'bad' | 'warn'; text: string } | null;

export function UsersPanel({ users, currentUserId }: { users: UserRow[]; currentUserId: string }) {
  const t = useTranslations('users');
  const tRole = useTranslations('role');
  const te = useTranslations('errors');
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<Notice>(null);
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    formState: { errors },
  } = useForm<InviteUserInput>({ resolver: zodResolver(inviteUserSchema), defaultValues: { role: 'user' } });
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');

  const invite = handleSubmit((values) =>
    start(async () => {
      setNotice(null);
      const res = await inviteUser(values);
      if (!res.ok) return setNotice({ tone: res.code === 'partial' ? 'warn' : 'bad', text: res.error });
      setNotice({ tone: 'good', text: t('addedNotice', { email: values.email }) });
      reset({ email: '', name: '', role: 'user', password: '' });
    }),
  );

  /** A random starting password, shown in the box so the owner can read it out once. */
  const suggest = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
    setValue('password', Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('') + '-' + Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => alphabet[b % alphabet.length]).join(''), { shouldValidate: true });
  };

  const savePassword = (row: UserRow) =>
    start(async () => {
      setNotice(null);
      const res = await resetUserPassword({ userId: row.userId, password: newPassword });
      if (!res.ok) return setNotice({ tone: 'bad', text: res.error });
      setNotice({ tone: 'good', text: t('passwordReset', { name: row.name }) });
      setResetFor(null);
      setNewPassword('');
    });

  const toggle = (row: UserRow) =>
    start(async () => {
      setNotice(null);
      const res = await (row.isActive ? disableUser : enableUser)({ userId: row.userId });
      setNotice(
        res.ok
          ? { tone: 'good', text: t(row.isActive ? 'disabled' : 'enabled', { name: row.name }) }
          : { tone: res.code === 'partial' ? 'warn' : 'bad', text: res.error },
      );
    });

  return (
    <div className="stack">
      {notice && (
        <p role={notice.tone === 'bad' ? 'alert' : 'status'} className={`alert ${notice.tone}`}>
          {notice.text}
        </p>
      )}

      <Card>
        <div className="cardtitle">{t('addTitle')}</div>
        <p className="muted" style={{ marginTop: 0 }}>
          {t('addHelp')}
        </p>
        <form onSubmit={invite} noValidate>
          <div className="fieldrow">
            <Field id="u-name" label={t('name')} error={errors.name ? te(`field.${errors.name.message}`) : undefined}>
              <input id="u-name" autoComplete="off" {...register('name')} />
            </Field>
            <Field id="u-email" label={t('email')} error={errors.email ? te(`field.${errors.email.message}`) : undefined}>
              <input id="u-email" type="email" inputMode="email" autoComplete="off" {...register('email')} />
            </Field>
            <Field id="u-password" label={t('password')} hint={t('passwordHint')} error={errors.password ? te(`field.${errors.password.message}`) : undefined}>
              <input id="u-password" type="text" autoComplete="off" spellCheck={false} {...register('password')} />
            </Field>
            <Field id="u-role" label={t('role')}>
              <select id="u-role" {...register('role')}>
                <option value="user">{tRole('user')}</option>
                <option value="admin">{tRole('admin')}</option>
              </select>
            </Field>
          </div>
          <button type="submit" className="btn primary" disabled={pending}>
            {t('add')}
          </button>{' '}
          <button type="button" className="btn ghost" disabled={pending} onClick={suggest}>
            {t('generate')}
          </button>
        </form>
      </Card>

      <Card>
        <div className="cardtitle">{t('listTitle')}</div>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>{t('name')}</th>
                <th>{t('email')}</th>
                <th>{t('role')}</th>
                <th>{t('status')}</th>
                <th>{t('added')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.userId}>
                  <td>{u.name}</td>
                  <td>{u.email ?? '—'}</td>
                  <td>{tRole(u.role)}</td>
                  <td>
                    <Chip tone={u.isActive ? 'good' : 'muted'}>{u.isActive ? t('active') : t('inactive')}</Chip>
                  </td>
                  <td className="nowrap num">{u.invitedOn ?? '—'}</td>
                  <td className="nowrap">
                    {u.userId === currentUserId ? (
                      <span className="muted">{t('you')}</span>
                    ) : resetFor === u.userId ? (
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <input aria-label={t('newPassword')} type="text" autoComplete="off" spellCheck={false} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
                        <button type="button" className="btn primary sm" disabled={pending || newPassword.length < 12} onClick={() => savePassword(u)}>{t('savePassword')}</button>
                        <button type="button" className="btn ghost sm" onClick={() => { setResetFor(null); setNewPassword(''); }}>{t('cancel')}</button>
                      </span>
                    ) : (
                      <span style={{ display: 'inline-flex', gap: 6 }}>
                        <button type="button" className="btn ghost sm" disabled={pending} onClick={() => setResetFor(u.userId)}>{t('resetPassword')}</button>
                        <button type="button" className={`btn sm ${u.isActive ? 'danger' : 'ghost'}`} disabled={pending} onClick={() => toggle(u)}>
                          {u.isActive ? t('disable') : t('enable')}
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
