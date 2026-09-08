import { useCallback, useEffect, useState } from "react";
import { Alert, Input, Modal } from "antd";
import { useAPI } from "../contexts/APIProvider";

/** One file, as the prompt needs to see it. */
export interface DownloadTarget {
  /**
   * Where the file is served from. Carries `lapid` for a linked attachment,
   * which is stored on the post that links to it rather than in a media row of
   * its own.
   */
  url: string;
  /** Named separately from the URL: it is what a ticket is asked for. */
  mediaId: string;
  /** Shown in the prompt, so it is clear which file is about to be saved. */
  filename: string;
}

interface DownloadPromptModalProps {
  target: DownloadTarget | null;
  onClose: () => void;
}

/**
 * The download code, and what happens once it is right.
 *
 * The code is a second thing to know on top of an administrator's password, so
 * that a session left open on an unlocked machine is not also a way to walk
 * off with the library. It is checked on the server - nothing here knows it.
 */
function DownloadPromptModal(props: DownloadPromptModalProps) {
  const { target, onClose } = props;
  const { api } = useAPI();
  const [ code, setCode ] = useState('');
  const [ requesting, setRequesting ] = useState(false);
  const [ error, setError ] = useState<string | null>(null);

  // A code typed for one file is not carried over to the next.
  useEffect(() => {
    setCode('');
    setError(null);
  }, [target]);

  /**
   * Turns the code into a ticket, then navigates to the file with it.
   *
   * A plain navigation rather than a `fetch` or an `<a download>`: the answer
   * is a `Content-Disposition` attachment, so the browser saves it and leaves
   * the page - the reader included - open behind it, and the file is never
   * pulled into memory on its way to disk.
   */
  const startDownload = useCallback(() => {
    if (!target) {
      return;
    }
    setRequesting(true);
    setError(null);
    void (async () => {
      try {
        const { token } = await api.createDownloadTicket(target.mediaId, code);
        const url = new URL(target.url, window.location.origin);
        url.searchParams.set('dlt', token);
        window.location.href = url.toString();
        onClose();
      }
      catch (error) {
        setError(error instanceof Error ? error.message : 'Could not start the download');
      }
      finally {
        setRequesting(false);
      }
    })();
  }, [ api, code, target, onClose ]);

  return (
    <Modal
      open={!!target}
      title="Download code"
      okText="Download"
      centered
      width={360}
      confirmLoading={requesting}
      okButtonProps={{ disabled: !code }}
      onOk={startDownload}
      onCancel={onClose}
    >
      <p className="text-body-secondary">
        {target?.filename}
      </p>
      <Input.Password
        value={code}
        autoFocus
        inputMode="numeric"
        placeholder="Enter the download code"
        onChange={(e) => {
          setCode(e.target.value);
          setError(null);
        }}
        onPressEnter={() => { if (code && !requesting) { startDownload(); } }}
      />
      {
        error ? (
          <Alert className="mt-3" type="error" showIcon title={error} />
        ) : null
      }
    </Modal>
  );
}

export default DownloadPromptModal;
