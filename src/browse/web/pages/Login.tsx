import "../assets/styles/Login.scss";
import { useCallback, useState } from "react";
import { Alert, Button, Card, Form, Input } from "antd";
import { LockOutlined, UserOutlined } from "@ant-design/icons";
import { useAuth } from "../contexts/AuthProvider";
import { APP_NAME } from "../utils/Misc";

interface LoginFormValues {
  username: string;
  password: string;
}

function Login() {
  const { signIn } = useAuth();
  const [ error, setError ] = useState<string | null>(null);
  const [ submitting, setSubmitting ] = useState(false);

  const handleSubmit = useCallback(async (values: LoginFormValues) => {
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
        <Form<LoginFormValues>
          layout="vertical"
          requiredMark={false}
          disabled={submitting}
          onFinish={(values) => void handleSubmit(values)}
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
      </Card>
    </div>
  );
}

export default Login;
