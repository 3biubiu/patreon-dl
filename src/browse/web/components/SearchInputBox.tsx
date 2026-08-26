import "../assets/styles/SearchInputBox.scss";
import { forwardRef, useCallback, useImperativeHandle, useState } from "react";
import { Input } from "antd";

export type SearchInputBoxOnConfirmListener = (value: string) => void;

export interface SearchInputBoxHandle {
  onConfirm: (listener: SearchInputBoxOnConfirmListener | null) => void;
  setInput: (value: string) => void;
}

interface SearchInputBoxProps {
  placeholder?: string;
  onConfirm?: SearchInputBoxOnConfirmListener | null;
}

const SearchInputBox = forwardRef<SearchInputBoxHandle, SearchInputBoxProps>((props, ref) => {
  const [ onConfirm, setOnConfirmListener ] = useState<SearchInputBoxOnConfirmListener | null>(() => props.onConfirm || null);
  const [ input, setInput ] = useState('');

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setInput(e.target.value);
    },
    []
  );

  // Takes the value from the event rather than from state: clearing the box
  // fires this in the same tick as the change, before state has caught up.
  const handleSearch = useCallback((value: string) => {
    if (onConfirm) {
      onConfirm(value);
    }
  }, [onConfirm]);

  useImperativeHandle(ref, () => ({
    onConfirm: (listener: SearchInputBoxOnConfirmListener | null) => {
      setOnConfirmListener(() => listener);
    },
    setInput: (value: string) => {
      setInput(value);
    }
  }));

  return (
    <Input.Search
      className="search-input-box"
      allowClear
      placeholder={props.placeholder}
      value={input}
      onChange={handleChange}
      onSearch={handleSearch}
    />
  )
});

export default SearchInputBox;
