import "../assets/styles/Login.scss";
import { useCallback, useState } from "react";
import { Alert, Button, Card, Form, Input } from "antd";
import { LockOutlined, UserOutlined } from "@ant-design/icons";
import { useAPI } from "../contexts/APIProvider";
import { useAuth } from "../contexts/AuthProvider";
import { APP_NAME } from "../utils/Misc";
import { useLanguage } from "../contexts/LanguageProvider";

interface LoginFormValues {
  username: string;
  password: string;
}

interface RegisterFormValues {
  username: string;
  password: string;
  confirmPassword: string;
}

/**
 * Which half of the card is showing. One card rather than two routes: applying
 * for an account is something you do from the sign-in screen, having just
 * found out you cannot get in.
 */
type Mode = 'signIn' | 'register';

function Login() {
  const { api } = useAPI();
  const { signIn } = useAuth();
  const { t } = useLanguage();
  const [ mode, setMode ] = useState<Mode>('signIn');
  const [ error, setError ] = useState<string | null>(null);
  /** Shown on the sign-in form after an application goes through. */
  const [ applied, setApplied ] = useState<string | null>(null);
  const [ submitting, setSubmitting ] = useState(false);

  const switchMode = useCallback((to: Mode) => {
    setError(null);
    setApplied(null);
    setMode(to);
  }, []);

  const handleSignIn = useCallback(async (values: LoginFormValues) => {
    setError(null);
    setSubmitting(true);
    try {
      await signIn(values.username, values.password);
    }
    catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sign in');
    }
    finally {
      setSubmitting(false);
    }
  }, [signIn]);

  /**
   * An application is filed and that is all that happens - no session, no way
   * in. So the card goes back to the sign-in form with a note saying what to
   * expect, rather than leaving somebody waiting on a screen that will never
   * turn into the app.
   */
  const handleRegister = useCallback(async (values: RegisterFormValues) => {
    setError(null);
    setSubmitting(true);
    try {
      await api.register(values.username, values.password);
      setApplied(values.username.trim());
      setMode('signIn');
    }
    catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the application');
    }
    finally {
      setSubmitting(false);
    }
  }, [api]);

  return (
    <div className="login">
      <Card className="login__card">
        <div className="login__brand">
          <span className="login__logo" aria-hidden="true">B</span>
          <span>{APP_NAME}</span>
        </div>
        {
          error ? (
            <Alert className="login__error" type="error" message={error} showIcon />
          ) : null
        }
        {
          applied ? (
            <Alert
              className="login__error"
              type="success"
              showIcon
              title={t('login_sent_for', { name: applied })}
              description={t('login_approval_note')}
            />
          ) : null
        }
        {
          mode === 'signIn' ? (
            <>
              <Form<LoginFormValues>
                layout="vertical"
                requiredMark={false}
                disabled={submitting}
                onFinish={(values) => void handleSignIn(values)}
              >
                <Form.Item
                  name="username"
                  label={t('login_username')}
                  rules={[ { required: true, message: t('login_enter_username') } ]}
                >
                  <Input
                    prefix={<UserOutlined />}
                    autoComplete="username"
                    autoFocus
                  />
                </Form.Item>
                <Form.Item
                  name="password"
                  label={t('login_password')}
                  rules={[ { required: true, message: t('login_enter_password') } ]}
                >
                  <Input.Password
                    prefix={<LockOutlined />}
                    autoComplete="current-password"
                  />
                </Form.Item>
                <Button
                  type="primary"
                  htmlType="submit"
                  block
                  loading={submitting}
                >
                  {t('login_signin')}
                </Button>
              </Form>
              <div className="login__switch">
                <span>{t('login_no_account')}</span>
                <Button type="link" size="small" onClick={() => switchMode('register')}>
                  {t('login_apply')}
                </Button>
              </div>
            </>
          ) : (
            <>
              <Form<RegisterFormValues>
                layout="vertical"
                requiredMark={false}
                disabled={submitting}
                onFinish={(values) => void handleRegister(values)}
              >
                <Form.Item
                  name="username"
                  label={t('login_username')}
                  rules={[
                    { required: true, message: t('login_choose_username') },
                    { max: 32, message: t('login_username_max') }
                  ]}
                >
                  <Input
                    prefix={<UserOutlined />}
                    autoComplete="username"
                    autoFocus
                  />
                </Form.Item>
                <Form.Item
                  name="password"
                  label={t('login_password')}
                  rules={[
                    { required: true, message: t('login_choose_password') },
                    { min: 6, message: t('login_password_min') }
                  ]}
                >
                  <Input.Password
                    prefix={<LockOutlined />}
                    autoComplete="new-password"
                  />
                </Form.Item>
                <Form.Item
                  name="confirmPassword"
                  label={t('login_confirm_password')}
                  dependencies={[ 'password' ]}
                  rules={[
                    { required: true, message: t('login_type_password_again') },
                    // Caught here rather than by the server, which is only
                    // ever sent the one password.
                    ({ getFieldValue }) => ({
                      validator: (_, value) => (
                        !value || value === getFieldValue('password') ?
                          Promise.resolve() :
                          Promise.reject(Error(t('login_password_mismatch')))
                      )
                    })
                  ]}
                >
                  <Input.Password
                    prefix={<LockOutlined />}
                    autoComplete="new-password"
                  />
                </Form.Item>
                <Button
                  type="primary"
                  htmlType="submit"
                  block
                  loading={submitting}
                >
                  {t('login_send_application')}
                </Button>
              </Form>
              <div className="login__switch">
                <span>{t('login_admin_reviews')}</span>
                <Button type="link" size="small" onClick={() => switchMode('signIn')}>
                  {t('login_back_to_signin')}
                </Button>
              </div>
            </>
          )
        }
      </Card>
    </div>
  );
}

export default Login;
