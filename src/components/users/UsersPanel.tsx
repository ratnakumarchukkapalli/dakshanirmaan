'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { disableUser, enableUser, inviteUser } from '@/app/actions/admin';
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
    formState: { errors },
  } = useForm<InviteUserInput>({ resolver: zodResolver(inviteUserSchema), defaultValues: { role: 'user' } });

  const invite = handleSubmit((values) =>
    start(async () => {
      setNotice(null);
      const res = await inviteUser(values);
      if (!res.ok) return setNotice({ tone: res.code === 'partial' ? 'warn' : 'bad', text: res.error });
      setNotice({ tone: 'good', text: t('addedNotice', { email: values.email }) });
      reset({ email: '', name: '', role: 'user' });
    }),
  );

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
            <Field id="u-role" label={t('role')}>
              <select id="u-role" {...register('role')}>
                <option value="user">{tRole('user')}</option>
                <option value="admin">{tRole('admin')}</option>
              </select>
            </Field>
          </div>
          <button type="submit" className="btn primary" disabled={pending}>
            {t('add')}
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
                    ) : (
                      <button type="button" className={`btn sm ${u.isActive ? 'danger' : 'ghost'}`} disabled={pending} onClick={() => toggle(u)}>
                        {u.isActive ? t('disable') : t('enable')}
                      </button>
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
