package ynab

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestParseYnabTxMemoRef(t *testing.T) {
	cases := []struct {
		memo     string
		expected string
	}{
		{
			memo:     "ref: 276226; desc: TAMARINDOS; auto: 1",
			expected: "276226",
		},
		{
			memo:     `{"ref":"20240226_174848","desc":"PedidosYa PROPINAS  GT"}`,
			expected: "20240226_174848",
		},
		{
			memo:     "Entered automatically by YNAB",
			expected: "",
		},
		{
			memo:     "ref: 20240326_140540; desc: MIPAGO CLARO RECURRENC GT;",
			expected: "20240326_140540",
		},
	}
	for _, c := range cases {
		t.Run(c.memo, func(t *testing.T) {
			parsed, err := ParseYnabTransactionMemo(&c.memo)
			assert.Nil(t, err)
			assert.Equal(t, c.expected, parsed.Ref)
		})
	}
}
