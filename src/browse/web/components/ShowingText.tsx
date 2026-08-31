import { useLanguage } from "../contexts/LanguageProvider";

interface ShowingTextProps {
  total: number;
  page: number;
  itemsPerPage: number;
  subject: {
    singular: string;
    plural: string;
  } | string;
}

function ShowingText(props: ShowingTextProps) {
  const { total, page, itemsPerPage: limit } = props;
  const { t } = useLanguage();
  
  if (total > limit) {
    const offset = (page - 1) * limit;
    const start = offset + 1;
    const end = Math.min(offset + limit, total);
    const subject = typeof props.subject === 'string' ? props.subject : props.subject.plural;
    return t('showing_range', { start, end, total, subject });
  } else {
    const subject = typeof props.subject === 'string' ? props.subject
      : total === 1 ? props.subject.singular
      : props.subject.plural;
    return t('total_count', { total, subject });
  }
}

export default ShowingText;