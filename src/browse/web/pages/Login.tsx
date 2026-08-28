import "../assets/styles/Login.scss";
import { useCallback, useState } from "react";
import { Alert, Button, Card, Form, Input } from "antd";
import { LockOutlined, UserOutlined } from "@ant-design/icons";
import { useAPI } from "../contexts/APIProvider";
import { useAuth } from "../contexts/AuthProvider";
import { APP_NAME } from "../utils/Misc";

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
              title={`Sent for "${applied}"`}
              description="An administrator has to approve it before you can sign in."
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
                  label="Username"
                  rules={[ { required: true, message: 'Enter your username' } ]}
                >
                  <Input
                    prefix={<UserOutlined />}
                    autoComplete="username"
                    autoFocus
                  />
                </Form.Item>
                <Form.Item
                  name="password"
                  label="Password"
                  rules={[ { required: true, message: 'Enter your password' } ]}
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
                  Sign in
                </Button>
              </Form>
              <div className="login__switch">
                <span>No account?</span>
                <Button type="link" size="small" onClick={() => switchMode('register')}>
                  Apply for one
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
                  label="Username"
                  rules={[
                    { required: true, message: 'Choose a username' },
                    { max: 32, message: 'At most 32 characters' }
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
                  label="Password"
                  rules={[
                    { required: true, message: 'Choose a password' },
                    { min: 6, message: 'At least 6 characters' }
                  ]}
                >
                  <Input.Password
                    prefix={<LockOutlined />}
                    autoComplete="new-password"
                  />
                </Form.Item>
                <Form.Item
                  name="confirmPassword"
                  label="Confirm password"
                  dependencies={[ 'password' ]}
                  rules={[
                    { required: true, message: 'Type the password again' },
                    // Caught here rather than by the server, which is only
                    // ever sent the one password.
                    ({ getFieldValue }) => ({
                      validator: (_, value) => (
                        !value || value === getFieldValue('password') ?
                          Promise.resolve() :
                          Promise.reject(Error('The two passwords do not match'))
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
                  Send application
                </Button>
              </Form>
              <div className="login__switch">
                <span>An administrator reviews every application.</span>
                <Button type="link" size="small" onClick={() => switchMode('signIn')}>
                  Back to sign in
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
