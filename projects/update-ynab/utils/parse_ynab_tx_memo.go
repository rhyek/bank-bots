package utils

import (
	"encoding/json"
	"fmt"
	"regexp"
)

type ParsedYnabTransactionMemo struct {
	Ref string
}

func ParseYnabTransactionMemo(memo *string) (ParsedYnabTransactionMemo, error) {
	parsed := ParsedYnabTransactionMemo{}
	memo_b := []byte(*memo)
	if json.Valid(memo_b) {
		err := json.Unmarshal(memo_b, &parsed)
		if err != nil {
			return parsed, err
		}
		if parsed.Ref == "" {
			return parsed, fmt.Errorf("ref was empty for memo %v", memo)
		}
	}

	rgx := regexp.MustCompile(`ref: ([\d_]+);`)
	if matches := rgx.FindStringSubmatch(*memo); matches != nil {
		ref := matches[1]
		parsed.Ref = ref
	}

	return parsed, nil
}
